import { AUDIO_LIMITS, AudioPipelineError, type NormalizedAudio } from './limits';
import { conditionForRecognition } from './speech';

export function assertFiniteSamples(samples: Float32Array): void {
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) {
      throw new AudioPipelineError(
        'AUDIO_INVALID',
        'normalize',
        'Decoded audio contains non-finite samples.',
      );
    }
  }
}

export function clampSamples(samples: Float32Array): void {
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    if (value > 1) samples[i] = 1;
    else if (value < -1) samples[i] = -1;
  }
}

export function downmixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  const mono = new Float32Array(length);

  if (numberOfChannels === 1) {
    mono.set(buffer.getChannelData(0));
    return mono;
  }

  const channels = Array.from({ length: numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const weight = 1 / numberOfChannels;

  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (let c = 0; c < numberOfChannels; c += 1) {
      sum += channels[c][i] * weight;
    }
    mono[i] = sum;
  }

  return mono;
}

export async function resampleMono(
  mono: Float32Array,
  sourceRate: number,
  targetRate: number,
): Promise<Float32Array> {
  if (sourceRate === targetRate) {
    return mono.slice();
  }

  const duration = mono.length / sourceRate;
  const frameCount = Math.max(1, Math.ceil(duration * targetRate));
  const offline = new OfflineAudioContext(1, frameCount, targetRate);
  const buffer = offline.createBuffer(1, mono.length, sourceRate);
  buffer.copyToChannel(mono, 0);

  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);

  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

export function concatFloat32(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function analyzeLevels(samples: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
    sumSquares += samples[i] * samples[i];
  }
  return {
    peak,
    rms: samples.length ? Math.sqrt(sumSquares / samples.length) : 0,
  };
}

export async function audioBufferToNormalized(
  decoded: AudioBuffer,
  options?: { maxDurationSeconds?: number },
): Promise<NormalizedAudio> {
  const maxDuration = options?.maxDurationSeconds ?? AUDIO_LIMITS.maxDurationSeconds;
  if (decoded.duration > maxDuration) {
    throw new AudioPipelineError(
      'AUDIO_TOO_LONG',
      'normalize',
      `Decoded audio exceeds the ${Math.round(maxDuration / 60)} minute limit.`,
    );
  }

  const warnings: string[] = [];
  const mono = downmixToMono(decoded);
  const samples = await resampleMono(mono, decoded.sampleRate, AUDIO_LIMITS.targetSampleRate);

  assertFiniteSamples(samples);
  clampSamples(samples);

  if (samples.length === 0) {
    throw new AudioPipelineError('AUDIO_EMPTY', 'normalize', 'Normalized audio is empty.');
  }

  const { peak, rms } = analyzeLevels(samples);
  if (peak >= 0.99) {
    warnings.push('Audio may be clipped.');
  }

  // Rumble out, level up. Dictaphone and phone recordings are routinely both
  // quiet and full of handling noise, and the model has no gain control.
  const { gain } = conditionForRecognition(samples);
  clampSamples(samples);

  if (rms < 0.001 && gain <= 1.01) {
    warnings.push('Audio appears very quiet. Transcription quality may be poor.');
  } else if (gain > 1.5) {
    warnings.push(`Quiet recording — level raised ${gain.toFixed(1)}x before recognition.`);
  }

  return {
    samples,
    sampleRate: AUDIO_LIMITS.targetSampleRate,
    channels: 1,
    durationSeconds: samples.length / AUDIO_LIMITS.targetSampleRate,
    warnings,
  };
}

export async function normalizeAudioBlob(
  blob: Blob,
  options?: { maxDurationSeconds?: number; signal?: AbortSignal },
): Promise<NormalizedAudio> {
  if (options?.signal?.aborted) {
    throw new AudioPipelineError('CANCELLED', 'decode', 'Audio normalization cancelled.');
  }

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

  const arrayBuffer = await blob.arrayBuffer();
  if (options?.signal?.aborted) {
    throw new AudioPipelineError('CANCELLED', 'decode', 'Audio normalization cancelled.');
  }

  const context = new AudioContext();
  let decoded: AudioBuffer;

  try {
    decoded = await context.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new AudioPipelineError(
      'AUDIO_DECODE_UNSUPPORTED',
      'decode',
      'This browser could not decode the selected audio file.',
    );
  } finally {
    await context.close().catch(() => undefined);
  }

  return audioBufferToNormalized(decoded, options);
}
