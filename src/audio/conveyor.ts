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
import { analyzeLevels } from './normalize';

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

function joinTexts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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

    const { rms } = analyzeLevels(window.samples);
    if (rms < 0.0004) {
      options.onChunkProgress?.({
        phase: 'merge',
        chunkIndex: window.index,
        chunkTotal: window.total,
        windowStartSeconds: window.startSeconds,
        windowEndSeconds: window.endSeconds,
        ratio: window.total ? (window.index + 1) / window.total : 1,
        message: `Skipped quiet window ${window.index + 1}/${window.total}`,
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
      text:
        options.timestamps === 'none'
          ? joinTexts(textParts)
          : segments.map((segment) => segment.text).join(' ').trim() || joinTexts(textParts),
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
      text: joinTexts(textParts),
      segments: [],
      durationSeconds,
      warnings,
    };
  }

  return {
    text: segments.map((segment) => segment.text).join(' ').trim() || joinTexts(textParts),
    segments,
    durationSeconds,
    warnings,
  };
}
