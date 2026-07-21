import { isMobileUA } from '../platform/environment';

export const AUDIO_LIMITS = {
  /** Hard cap on uploaded container size (audio/video). Decoding stays windowed. */
  maxSourceBytes: 2 * 1024 * 1024 * 1024,
  /** Absolute duration cap for conveyor jobs. */
  maxDurationSeconds: 3 * 60 * 60,
  /** Prefer full in-memory decode only for tiny clips. */
  inlineDecodeMaxBytes: 12 * 1024 * 1024,
  inlineDecodeMaxSeconds: 90,
  targetSampleRate: 16_000 as const,
  maxRecordingSeconds: 5 * 60,
  /** Conveyor windowing — keep each PCM slice small and reuse one model. */
  windowSeconds: 30,
  overlapSeconds: 5,
  /** Pause between windows so UI/GC can breathe. */
  interChunkYieldMs: 16,
} as const;

/**
 * Mobile browsers give a tab a far smaller memory budget than the device's RAM
 * suggests, and exceeding it kills the tab outright rather than throwing. Every
 * mobile figure below exists to lower the peak, not to save time.
 */
export const MOBILE_AUDIO_LIMITS = {
  /** A 90 s AudioBuffer at the source rate is ~35 MB before resampling. */
  inlineDecodeMaxSeconds: 30,
  /** Halves the peak encoder tensor versus the desktop window. */
  windowSeconds: 15,
  overlapSeconds: 3,
} as const;

/**
 * Effective audio limits for this device.
 *
 * Read through this — never off AUDIO_LIMITS directly in UI code, or the
 * interface ends up describing a pipeline the device is not running.
 */
export function effectiveAudioLimits(): {
  inlineDecodeMaxSeconds: number;
  windowSeconds: number;
  overlapSeconds: number;
} {
  return isMobileUA()
    ? { ...MOBILE_AUDIO_LIMITS }
    : {
        inlineDecodeMaxSeconds: AUDIO_LIMITS.inlineDecodeMaxSeconds,
        windowSeconds: AUDIO_LIMITS.windowSeconds,
        overlapSeconds: AUDIO_LIMITS.overlapSeconds,
      };
}

export function getInlineDecodeMaxSeconds(): number {
  return effectiveAudioLimits().inlineDecodeMaxSeconds;
}

export function getWindowSeconds(): number {
  return effectiveAudioLimits().windowSeconds;
}

export function getOverlapSeconds(): number {
  return effectiveAudioLimits().overlapSeconds;
}

export type NormalizedAudio = {
  samples: Float32Array;
  sampleRate: 16000;
  channels: 1;
  durationSeconds: number;
  warnings: string[];
};

export class AudioPipelineError extends Error {
  readonly code: string;
  readonly phase: 'input' | 'decode' | 'normalize';
  readonly recoverable: boolean;

  constructor(
    code: string,
    phase: 'input' | 'decode' | 'normalize',
    message: string,
    recoverable = true,
  ) {
    super(message);
    this.name = 'AudioPipelineError';
    this.code = code;
    this.phase = phase;
    this.recoverable = recoverable;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AudioPipelineError('CANCELLED', 'decode', 'Audio pipeline cancelled.');
  }
}

export function yieldToMain(ms = AUDIO_LIMITS.interChunkYieldMs): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
