import type { InferenceClient } from '../inference/requestManager';
import type {
  LanguageOption,
  ProgressEvent,
  RuntimePreference,
  TimestampsOption,
  TranscriptResult,
  TranscriptSegment,
} from '../inference/types';
import {
  throwIfAborted,
  yieldToMain,
  getWindowSeconds,
  getOverlapSeconds,
} from './limits';
import { iterateAudioWindows } from './mediaProbe';
import { containsSpeech } from './speech';
import { finalizeTranscript, joinOverlappingText } from '../export/transcriptText';

export type ConveyorProgress = {
  phase: 'extract' | 'infer' | 'merge';
  chunkIndex: number;
  chunkTotal: number;
  windowStartSeconds: number;
  windowEndSeconds: number;
  ratio: number;
  message: string;
};

export type ConveyorOptions = {
  blob: Blob;
  profileId: string;
  runtimePreference: RuntimePreference;
  language: LanguageOption;
  timestamps: TimestampsOption;
  client: InferenceClient;
  signal?: AbortSignal;
  onChunkProgress?: (progress: ConveyorProgress) => void;
  onModelProgress?: (progress: ProgressEvent) => void;
  onPartialResult?: (partial: TranscriptResult) => void;
};

function stitchSegments(
  existing: TranscriptSegment[],
  incoming: TranscriptSegment[],
  windowStart: number,
  windowEnd: number,
  overlapSeconds: number,
  isFirst: boolean,
  isLast: boolean,
): TranscriptSegment[] {
  const keepFrom = isFirst ? windowStart : windowStart + overlapSeconds / 2;
  const keepUntil = isLast ? windowEnd + 1 : windowEnd - overlapSeconds / 2;

  const shifted = incoming
    .map((segment) => ({
      startSeconds: segment.startSeconds + windowStart,
      endSeconds: segment.endSeconds + windowStart,
      text: segment.text.trim(),
    }))
    .filter(
      (segment) =>
        segment.text.length > 0 &&
        Number.isFinite(segment.startSeconds) &&
        Number.isFinite(segment.endSeconds) &&
        segment.endSeconds >= segment.startSeconds &&
        segment.startSeconds >= keepFrom - 1e-3 &&
        segment.startSeconds < keepUntil + 1e-3,
    );

  return existing.concat(shifted);
}

/**
 * Joins window transcripts, removing what the overlap transcribed twice.
 *
 * Windows deliberately overlap so no word is cut in half, which means every
 * seam contains the same few seconds of speech from both sides. The timestamped
 * path drops the duplicate by time; without timestamps the repeat has to be
 * found in the words themselves.
 */
function joinTexts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((joined, part) => (joined ? joinOverlappingText(joined, part) : part), '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same overlap problem, applied to the text carried by stitched segments. */
function joinSegmentTexts(items: TranscriptSegment[]): string {
  return joinTexts(items.map((segment) => segment.text));
}

/**
 * Conveyor transcription: extract → infer → release PCM → next window.
 * The Whisper pipeline stays resident in the Worker across chunks.
 */
export async function transcribeMediaConveyor(
  options: ConveyorOptions,
): Promise<TranscriptResult> {
  const windowSeconds = getWindowSeconds();
  const overlapSeconds = getOverlapSeconds();
  const warnings: string[] = [];
  const textParts: string[] = [];
  let segments: TranscriptSegment[] = [];
  let durationSeconds = 0;

  // Force segment timestamps inside the conveyor so windows can be stitched.
  const timestamps: TimestampsOption =
    options.timestamps === 'none' ? 'segment' : options.timestamps;

  for await (const window of iterateAudioWindows(options.blob, {
    windowSeconds,
    overlapSeconds,
    signal: options.signal,
  })) {
    throwIfAborted(options.signal);
    durationSeconds = Math.max(durationSeconds, window.endSeconds);

    options.onChunkProgress?.({
      phase: 'extract',
      chunkIndex: window.index,
      chunkTotal: window.total,
      windowStartSeconds: window.startSeconds,
      windowEndSeconds: window.endSeconds,
      ratio: window.total ? window.index / window.total : 0,
      message: `Extracting audio window ${window.index + 1}/${window.total}…`,
    });

    options.onChunkProgress?.({
      phase: 'infer',
      chunkIndex: window.index,
      chunkTotal: window.total,
      windowStartSeconds: window.startSeconds,
      windowEndSeconds: window.endSeconds,
      ratio: window.total ? (window.index + 0.35) / window.total : 0,
      message: `Transcribing window ${window.index + 1}/${window.total}…`,
    });

    // Whisper does not stay quiet when the audio is: given silence it invents
    // text and repeats it to fill the window. Skipping speechless windows
    // removes that failure mode instead of cleaning it up afterwards. The test
    // is relative to the window's own level, so it still works on a quiet
    // recording — the previous fixed threshold only caught digital silence.
    if (!containsSpeech(window.samples)) {
      options.onChunkProgress?.({
        phase: 'merge',
        chunkIndex: window.index,
        chunkTotal: window.total,
        windowStartSeconds: window.startSeconds,
        windowEndSeconds: window.endSeconds,
        ratio: window.total ? (window.index + 1) / window.total : 1,
        message: `No speech in window ${window.index + 1}/${window.total} — skipped`,
      });
      await yieldToMain();
      continue;
    }

    const result = await options.client.transcribe({
      profileId: options.profileId,
      runtimePreference: options.runtimePreference,
      audio: window.samples,
      language: options.language,
      timestamps,
      onProgress: options.onModelProgress,
    });

    // window.samples was transferred to the Worker — do not touch it again.
    const isFirst = window.index === 0;
    const isLast = window.index === window.total - 1;

    if (result.warnings.length) {
      for (const warning of result.warnings) {
        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }
      }
    }

    if (result.text.trim()) {
      textParts.push(result.text.trim());
    }

    segments = stitchSegments(
      segments,
      result.segments,
      window.startSeconds,
      window.endSeconds,
      overlapSeconds,
      isFirst,
      isLast,
    );

    const partial: TranscriptResult = {
      // Partials stay unparagraphed: reflowing the text on every window would
      // make it jump around while the user is reading it.
      text:
        options.timestamps === 'none'
          ? joinTexts(textParts)
          : joinSegmentTexts(segments) || joinTexts(textParts),
      segments: options.timestamps === 'none' ? [] : segments,
      durationSeconds,
      warnings: [...warnings],
    };
    options.onPartialResult?.(partial);

    options.onChunkProgress?.({
      phase: 'merge',
      chunkIndex: window.index,
      chunkTotal: window.total,
      windowStartSeconds: window.startSeconds,
      windowEndSeconds: window.endSeconds,
      ratio: window.total ? (window.index + 1) / window.total : 1,
      message: `Merged window ${window.index + 1}/${window.total}`,
    });

    await yieldToMain();
  }

  if (options.timestamps === 'none') {
    return {
      text: finalizeTranscript(joinTexts(textParts)),
      segments: [],
      durationSeconds,
      warnings,
    };
  }

  return {
    text: finalizeTranscript(joinSegmentTexts(segments) || joinTexts(textParts)),
    segments,
    durationSeconds,
    warnings,
  };
}
