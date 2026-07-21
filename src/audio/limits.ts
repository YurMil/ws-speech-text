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
