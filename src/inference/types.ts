export type LanguageOption = 'auto' | 'en' | 'ru';
export type TimestampsOption = 'none' | 'segment';
export type RuntimePreference = 'auto' | 'webgpu' | 'wasm';

export type Envelope = {
  protocol: 1;
  requestId: string;
};

export type TranscriptSegment = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type TranscriptResult = {
  text: string;
  segments: TranscriptSegment[];
  detectedLanguage?: string;
  durationSeconds: number;
  warnings: string[];
};

export type ProgressEvent = {
  phase:
    | 'manifest'
    | 'download'
    | 'runtime-init'
    | 'model-init'
    | 'warmup'
    | 'inference'
    | 'finalize';
  status: 'started' | 'running' | 'completed';
  fileId?: string;
  loadedBytes?: number;
  totalBytes?: number;
  ratio?: number;
  approximate?: boolean;
};

export type RuntimeDiagnostics = {
  appVersion: string;
  buildId: string;
  transformersVersion: string;
  modelProfileId?: string;
  modelRevision?: string;
  requestedRuntime?: string;
  effectiveRuntime?: 'wasm' | 'webgpu';
  fallbackReasonCode?: string;
  cacheState?: 'unknown' | 'cold' | 'partial' | 'warm';
  preparationMs?: number;
  inferenceMs?: number;
  audioDurationSeconds?: number;
};

export type WorkerError = {
  code:
    | 'PROFILE_UNKNOWN'
    | 'RUNTIME_UNSUPPORTED'
    | 'RUNTIME_INIT_FAILED'
    | 'MODEL_DOWNLOAD_FAILED'
    | 'MODEL_INTEGRITY_FAILED'
    | 'MODEL_INIT_FAILED'
    | 'AUDIO_INVALID'
    | 'INFERENCE_FAILED'
    | 'OUT_OF_MEMORY'
    | 'CANCELLED'
    | 'PROTOCOL_UNSUPPORTED'
    | 'INTERNAL';
  phase: string;
  recoverable: boolean;
  fallbackAvailable?: boolean;
  diagnostic?: Record<string, string | number | boolean>;
};

export type TranscribeOptions = {
  language: LanguageOption;
  task: 'transcribe';
  timestamps: TimestampsOption;
};

export type WorkerRequest =
  | (Envelope & {
      type: 'PREPARE';
      profileId: string;
      runtimePreference: RuntimePreference;
    })
  | (Envelope & {
      type: 'TRANSCRIBE';
      profileId: string;
      runtimePreference: RuntimePreference;
      audio: Float32Array;
      options: TranscribeOptions;
    })
  | (Envelope & {
      type: 'CANCEL';
      targetRequestId: string;
    })
  | (Envelope & {
      type: 'DISPOSE';
    })
  | (Envelope & {
      type: 'GET_DIAGNOSTICS';
    });

export type WorkerResponse =
  | (Envelope & {
      type: 'READY';
      diagnostics: RuntimeDiagnostics;
    })
  | (Envelope & {
      type: 'PROGRESS';
      progress: ProgressEvent;
    })
  | (Envelope & {
      type: 'RESULT';
      result: TranscriptResult;
    })
  | (Envelope & {
      type: 'CANCELLED';
    })
  | (Envelope & {
      type: 'DIAGNOSTICS';
      diagnostics: RuntimeDiagnostics;
    })
  | (Envelope & {
      type: 'ERROR';
      error: WorkerError;
    });

export type ModelProfile = {
  id: string;
  label: string;
  modelId: string;
  revision: string;
  multilingual: boolean;
  approximateDownloadBytes: number;
  devices: Array<'wasm' | 'webgpu'>;
  dtypeByDevice: Partial<Record<'wasm' | 'webgpu', string>>;
  chunkLengthSeconds: number;
  strideLengthSeconds: number;
  maxDurationSeconds: number;
};

export type AppError = {
  code: string;
  phase: 'input' | 'decode' | 'normalize' | 'prepare' | 'infer' | 'export';
  recoverable: boolean;
  message: string;
};
