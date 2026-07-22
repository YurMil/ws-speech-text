import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Input,
  InputDisposedError,
} from 'mediabunny';
import {
  AUDIO_LIMITS,
  AudioPipelineError,
  throwIfAborted,
  getInlineDecodeMaxSeconds,
  getWindowSeconds,
  getOverlapSeconds,
} from './limits';
import { conditionForRecognition, findQuietestCut } from './speech';
import {
  assertFiniteSamples,
  clampSamples,
  concatFloat32,
  downmixToMono,
  resampleMono,
} from './normalize';

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mpeg',
  'mpg',
  'ogv',
]);

export type MediaKind = 'audio' | 'video' | 'unknown';

export type MediaProbe = {
  kind: MediaKind;
  durationSeconds: number;
  hasAudio: boolean;
  canDecodeAudio: boolean;
  byteLength: number;
  formatName?: string;
};

export function guessMediaKind(file: Blob & { name?: string; type?: string }): MediaKind {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';

  const name = file.name?.toLowerCase() ?? '';
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (ext) return 'audio';
  return 'unknown';
}

export function shouldUseConveyor(probe: MediaProbe, kind: MediaKind): boolean {
  if (kind === 'video') return true;
  if (probe.durationSeconds > getInlineDecodeMaxSeconds()) return true;
  if (probe.byteLength > AUDIO_LIMITS.inlineDecodeMaxBytes) return true;
  return false;
}

async function openInput(blob: Blob): Promise<Input> {
  return new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
}

export async function probeMedia(
  blob: Blob,
  options?: { signal?: AbortSignal },
): Promise<MediaProbe> {
  throwIfAborted(options?.signal);

  if (blob.size <= 0) {
    throw new AudioPipelineError('AUDIO_EMPTY', 'input', 'Selected file is empty.');
  }
  if (blob.size > AUDIO_LIMITS.maxSourceBytes) {
    throw new AudioPipelineError(
      'AUDIO_TOO_LARGE',
      'input',
      `File exceeds the ${Math.round(AUDIO_LIMITS.maxSourceBytes / (1024 * 1024 * 1024))} GB limit.`,
    );
  }

  const kindHint = guessMediaKind(blob);
  const input = await openInput(blob);

  try {
    throwIfAborted(options?.signal);
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) {
      throw new AudioPipelineError(
        'AUDIO_TRACK_MISSING',
        'decode',
        kindHint === 'video'
          ? 'This video has no audio track to transcribe.'
          : 'No audio track found in the selected file.',
      );
    }

    const canDecodeAudio = await audioTrack.canDecode();
    const durationSeconds = await input.computeDuration();
    const format = await input.getFormat();

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new AudioPipelineError(
        'AUDIO_DURATION_UNKNOWN',
        'decode',
        'Could not determine media duration.',
      );
    }

    if (durationSeconds > AUDIO_LIMITS.maxDurationSeconds) {
      throw new AudioPipelineError(
        'AUDIO_TOO_LONG',
        'normalize',
        `Media exceeds the ${Math.round(AUDIO_LIMITS.maxDurationSeconds / 3600)} hour limit.`,
      );
    }

    const videoTrack = await input.getPrimaryVideoTrack();
    const kind: MediaKind = videoTrack ? 'video' : kindHint === 'video' ? 'video' : 'audio';

    return {
      kind,
      durationSeconds,
      hasAudio: true,
      canDecodeAudio,
      byteLength: blob.size,
      formatName: format.name,
    };
  } catch (error) {
    if (error instanceof AudioPipelineError) {
      throw error;
    }
    if (error instanceof InputDisposedError) {
      throw new AudioPipelineError('CANCELLED', 'decode', 'Media probe cancelled.');
    }
    throw new AudioPipelineError(
      'AUDIO_DECODE_UNSUPPORTED',
      'decode',
      'This browser could not open the selected media file.',
    );
  } finally {
    input.dispose();
  }
}

export type ExtractedWindow = {
  index: number;
  total: number;
  startSeconds: number;
  endSeconds: number;
  samples: Float32Array;
};

/**
 * Opens one media Input and yields mono 16 kHz windows. Only one window's PCM
 * exists at a time after the consumer finishes the previous yield.
 */
export async function* iterateAudioWindows(
  blob: Blob,
  options?: {
    windowSeconds?: number;
    overlapSeconds?: number;
    signal?: AbortSignal;
  },
): AsyncGenerator<ExtractedWindow> {
  const windowSeconds = options?.windowSeconds ?? getWindowSeconds();
  const overlapSeconds = options?.overlapSeconds ?? getOverlapSeconds();
  const step = Math.max(1, windowSeconds - overlapSeconds);

  const input = await openInput(blob);
  try {
    throwIfAborted(options?.signal);
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) {
      throw new AudioPipelineError(
        'AUDIO_TRACK_MISSING',
        'decode',
        'No audio track found in the selected file.',
      );
    }
    if (!(await audioTrack.canDecode())) {
      throw new AudioPipelineError(
        'AUDIO_DECODE_UNSUPPORTED',
        'decode',
        'This browser cannot decode the audio track (WebCodecs).',
      );
    }

    const durationSeconds = await input.computeDuration();
    const sink = new AudioBufferSink(audioTrack);
    const starts: number[] = [];
    for (let start = 0; start < durationSeconds; start += step) {
      starts.push(start);
      if (start + windowSeconds >= durationSeconds) {
        break;
      }
    }
    if (starts.length === 0) {
      starts.push(0);
    }

    const total = starts.length;
    for (let index = 0; index < starts.length; index += 1) {
      throwIfAborted(options?.signal);
      const startSeconds = starts[index];
      const endSeconds = Math.min(startSeconds + windowSeconds, durationSeconds);
      let samples = await collectNormalizedRange(sink, startSeconds, endSeconds, options?.signal);
      let effectiveEnd = endSeconds;

      // Move the trailing edge to the nearest pause. A cut on a timer lands
      // mid-word about as often as not, and the model then has to guess at half
      // a syllable on both sides of the seam. Only the tail is moved, and never
      // on the final window: whatever is trimmed here is already covered by the
      // overlap of the window that follows.
      const isLast = index === starts.length - 1;
      if (!isLast && samples.length > AUDIO_LIMITS.targetSampleRate) {
        const cut = findQuietestCut(samples, samples.length, 1.5);
        if (cut > AUDIO_LIMITS.targetSampleRate && cut < samples.length) {
          samples = samples.slice(0, cut);
          effectiveEnd = startSeconds + cut / AUDIO_LIMITS.targetSampleRate;
        }
      }

      yield {
        index,
        total,
        startSeconds,
        endSeconds: effectiveEnd,
        samples,
      };
    }
  } catch (error) {
    if (error instanceof AudioPipelineError) {
      throw error;
    }
    if (error instanceof InputDisposedError || options?.signal?.aborted) {
      throw new AudioPipelineError('CANCELLED', 'decode', 'Chunk extraction cancelled.');
    }
    throw new AudioPipelineError(
      'AUDIO_DECODE_UNSUPPORTED',
      'decode',
      'Failed while extracting an audio window from the media file.',
    );
  } finally {
    input.dispose();
  }
}

async function collectNormalizedRange(
  sink: AudioBufferSink,
  startSeconds: number,
  endSeconds: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const parts: Float32Array[] = [];

  for await (const wrapped of sink.buffers(startSeconds, endSeconds)) {
    throwIfAborted(signal);
    const mono = downmixToMono(wrapped.buffer);
    const resampled = await resampleMono(
      mono,
      wrapped.buffer.sampleRate,
      AUDIO_LIMITS.targetSampleRate,
    );
    parts.push(resampled);
  }

  if (parts.length === 0) {
    // Silence / gap — still feed a tiny buffer so the conveyor keeps timestamps aligned.
    return new Float32Array(Math.max(1, Math.floor((endSeconds - startSeconds) * AUDIO_LIMITS.targetSampleRate)));
  }

  const samples = concatFloat32(parts);
  assertFiniteSamples(samples);
  clampSamples(samples);
  // Same conditioning the inline path applies, so a long recording is not fed
  // to the model at a different level than a short one would be.
  conditionForRecognition(samples);
  clampSamples(samples);
  return samples;
}
