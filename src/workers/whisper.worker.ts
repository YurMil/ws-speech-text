import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { getProfile, isMobileUA } from '../inference/profiles';
import type {
  ProgressEvent,
  RuntimeDiagnostics,
  RuntimePreference,
  TranscriptResult,
  TranscriptSegment,
  WorkerError,
  WorkerRequest,
  WorkerResponse,
} from '../inference/types';

env.allowLocalModels = false;
env.useBrowserCache = true;

// Transformers.js defaults ONNX Runtime's `wasmPaths` to a jsDelivr URL. That
// makes the runtime glue and the WASM binary come from a third-party CDN, which
// the host CSP rejects — and it defeats the copies the bundler already emitted
// next to this worker. Clearing it puts ORT back on its bundler-resolved local
// assets, so the only network traffic left is the pinned model download.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = undefined;
}

const APP_VERSION = __APP_VERSION__;
const BUILD_ID = __BUILD_ID__;
const TRANSFORMERS_VERSION = '3.x';

type PipelineSlot = {
  fingerprint: string;
  pipeline: AutomaticSpeechRecognitionPipeline;
  effectiveRuntime: 'wasm' | 'webgpu';
  profileId: string;
  modelRevision: string;
  preparationMs: number;
  fallbackReasonCode?: string;
};

let active: PipelineSlot | null = null;
let preparing: Promise<PipelineSlot> | null = null;
let cancelledRequestIds = new Set<string>();

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

function postProgress(requestId: string, progress: ProgressEvent): void {
  if (cancelledRequestIds.has(requestId)) {
    return;
  }
  post({
    protocol: 1,
    type: 'PROGRESS',
    requestId,
    progress,
  });
}

function postError(requestId: string, error: WorkerError): void {
  if (cancelledRequestIds.has(requestId)) {
    post({ protocol: 1, type: 'CANCELLED', requestId });
    return;
  }
  post({
    protocol: 1,
    type: 'ERROR',
    requestId,
    error,
  });
}

function createDiagnostics(partial: Partial<RuntimeDiagnostics> = {}): RuntimeDiagnostics {
  return {
    appVersion: APP_VERSION,
    buildId: BUILD_ID,
    transformersVersion: TRANSFORMERS_VERSION,
    cacheState: 'unknown',
    ...partial,
  };
}

function isCancelled(requestId: string): boolean {
  return cancelledRequestIds.has(requestId);
}

async function createPipeline(
  profileId: string,
  runtimePreference: RuntimePreference,
  requestId: string,
): Promise<PipelineSlot> {
  const profile = getProfile(profileId);
  if (!profile) {
    throw makeError('PROFILE_UNKNOWN', 'prepare', false);
  }

  const started = performance.now();
  let effectiveRuntime: 'wasm' | 'webgpu' = 'wasm';
  let fallbackReasonCode: string | undefined;

  postProgress(requestId, { phase: 'manifest', status: 'completed', ratio: 1 });
  postProgress(requestId, { phase: 'runtime-init', status: 'started' });

  let webGpuAvailable = false;

  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (!adapter) {
        fallbackReasonCode = 'WEBGPU_NO_ADAPTER';
      } else {
        const limit = adapter.limits?.maxStorageBufferBindingSize ?? 0;
        const MIN_REQUIRED_LIMIT = 128 * 1024 * 1024; // 128MB
        if (limit < MIN_REQUIRED_LIMIT) {
          fallbackReasonCode = `WEBGPU_BUFFER_LIMIT_LOW_${Math.round(limit / (1024 * 1024))}MB`;
        } else {
          webGpuAvailable = true;
        }
      }
    } catch {
      fallbackReasonCode = 'WEBGPU_ADAPTER_ERROR';
    }
  } else {
    fallbackReasonCode = 'WEBGPU_API_MISSING';
  }

  const isMobile = isMobileUA();
  const tryWebGpu =
    runtimePreference === 'webgpu' ||
    (runtimePreference === 'auto' && !isMobile && webGpuAvailable);

  if (runtimePreference === 'webgpu' && !webGpuAvailable) {
    throw makeError('RUNTIME_UNSUPPORTED', 'prepare', true, true);
  }

  const load = async (device: 'wasm' | 'webgpu') => {
    const dtype = (profile.dtypeByDevice[device] ??
      (device === 'webgpu' ? 'fp16' : 'q8')) as 'fp32' | 'fp16' | 'q8' | 'q4' | 'int8';
    return pipeline('automatic-speech-recognition', profile.modelId, {
      revision: profile.revision,
      device,
      dtype,
      progress_callback: (event: {
        status?: string;
        file?: string;
        loaded?: number;
        total?: number;
        progress?: number;
      }) => {
        if (isCancelled(requestId)) {
          return;
        }
        if (event.status === 'progress' || event.status === 'download') {
          postProgress(requestId, {
            phase: 'download',
            status: 'running',
            fileId: event.file,
            loadedBytes: event.loaded,
            totalBytes: event.total,
            ratio:
              typeof event.progress === 'number'
                ? event.progress / 100
                : event.total
                  ? (event.loaded ?? 0) / event.total
                  : undefined,
          });
        }
      },
    });
  };

  let asr: AutomaticSpeechRecognitionPipeline;

  if (tryWebGpu) {
    try {
      postProgress(requestId, { phase: 'model-init', status: 'started' });
      asr = await load('webgpu');
      effectiveRuntime = 'webgpu';
    } catch {
      fallbackReasonCode = 'WEBGPU_INIT_FAILED';
      postProgress(requestId, { phase: 'runtime-init', status: 'started' });
      asr = await load('wasm');
      effectiveRuntime = 'wasm';
    }
  } else {
    postProgress(requestId, { phase: 'model-init', status: 'started' });
    asr = await load('wasm');
    effectiveRuntime = 'wasm';
  }

  if (isCancelled(requestId)) {
    throw makeError('CANCELLED', 'prepare', true);
  }

  postProgress(requestId, { phase: 'warmup', status: 'completed', ratio: 1 });

  const fingerprint = [
    profile.modelId,
    profile.revision,
    effectiveRuntime,
    profile.dtypeByDevice[effectiveRuntime] ?? 'default',
    TRANSFORMERS_VERSION,
  ].join('|');

  return {
    fingerprint,
    pipeline: asr,
    effectiveRuntime,
    profileId: profile.id,
    modelRevision: profile.revision,
    preparationMs: Math.round(performance.now() - started),
    fallbackReasonCode,
  };
}

async function ensurePipeline(
  profileId: string,
  runtimePreference: RuntimePreference,
  requestId: string,
): Promise<PipelineSlot> {
  const profile = getProfile(profileId);
  if (!profile) {
    throw makeError('PROFILE_UNKNOWN', 'prepare', false);
  }

  const desiredRuntimeHint =
    runtimePreference === 'wasm'
      ? 'wasm'
      : runtimePreference === 'webgpu'
        ? 'webgpu'
        : active?.effectiveRuntime ?? 'auto';

  const desiredFingerprintPrefix = `${profile.modelId}|${profile.revision}|`;

  if (
    active &&
    active.profileId === profileId &&
    active.fingerprint.startsWith(desiredFingerprintPrefix) &&
    (runtimePreference === 'auto' ||
      active.effectiveRuntime === desiredRuntimeHint ||
      (runtimePreference === 'webgpu' && active.effectiveRuntime === 'wasm' && active.fallbackReasonCode))
  ) {
    return active;
  }

  if (!preparing) {
    preparing = createPipeline(profileId, runtimePreference, requestId)
      .then((slot) => {
        active = slot;
        preparing = null;
        return slot;
      })
      .catch((error) => {
        preparing = null;
        active = null;
        throw error;
      });
  }

  return preparing;
}

function normalizeResult(
  raw: unknown,
  durationSeconds: number,
): TranscriptResult {
  const warnings: string[] = [];
  const record = (raw ?? {}) as {
    text?: string;
    chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] }>;
  };

  const text = (record.text ?? '').trim();
  const segments: TranscriptSegment[] = [];

  if (Array.isArray(record.chunks)) {
    for (const chunk of record.chunks) {
      const start = chunk.timestamp?.[0];
      const end = chunk.timestamp?.[1];
      if (typeof start !== 'number' || typeof end !== 'number') {
        continue;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        continue;
      }
      segments.push({
        startSeconds: start,
        endSeconds: end,
        text: (chunk.text ?? '').trim(),
      });
    }
  }

  if (!text && segments.length === 0) {
    warnings.push('No speech detected.');
  }

  return {
    text: text || segments.map((segment) => segment.text).join(' ').trim(),
    segments,
    durationSeconds,
    warnings,
  };
}

function makeError(
  code: WorkerError['code'],
  phase: string,
  recoverable: boolean,
  fallbackAvailable?: boolean,
): WorkerError {
  return { code, phase, recoverable, fallbackAvailable };
}

function validateAudio(audio: Float32Array): void {
  if (!(audio instanceof Float32Array) || audio.length === 0) {
    throw makeError('AUDIO_INVALID', 'infer', true);
  }
  for (let i = 0; i < audio.length; i += 1) {
    if (!Number.isFinite(audio[i])) {
      throw makeError('AUDIO_INVALID', 'infer', true);
    }
  }
}

async function handlePrepare(request: Extract<WorkerRequest, { type: 'PREPARE' }>): Promise<void> {
  try {
    const slot = await ensurePipeline(request.profileId, request.runtimePreference, request.requestId);
    if (isCancelled(request.requestId)) {
      post({ protocol: 1, type: 'CANCELLED', requestId: request.requestId });
      return;
    }
    post({
      protocol: 1,
      type: 'READY',
      requestId: request.requestId,
      diagnostics: createDiagnostics({
        modelProfileId: slot.profileId,
        modelRevision: slot.modelRevision,
        requestedRuntime: request.runtimePreference,
        effectiveRuntime: slot.effectiveRuntime,
        fallbackReasonCode: slot.fallbackReasonCode,
        preparationMs: slot.preparationMs,
      }),
    });
  } catch (error) {
    postError(request.requestId, asWorkerError(error, 'prepare'));
  }
}

async function handleTranscribe(
  request: Extract<WorkerRequest, { type: 'TRANSCRIBE' }>,
): Promise<void> {
  try {
    validateAudio(request.audio);
    const durationSeconds = request.audio.length / 16000;
    const slot = await ensurePipeline(
      request.profileId,
      request.runtimePreference,
      request.requestId,
    );

    if (isCancelled(request.requestId)) {
      post({ protocol: 1, type: 'CANCELLED', requestId: request.requestId });
      return;
    }

    postProgress(request.requestId, {
      phase: 'inference',
      status: 'started',
      approximate: true,
    });

    const inferenceStarted = performance.now();
    const language =
      request.options.language === 'auto'
        ? undefined
        : request.options.language === 'ru'
          ? 'russian'
          : 'english';

    const raw = await slot.pipeline(request.audio, {
      ...(language ? { language } : {}),
      task: request.options.task,
      return_timestamps: request.options.timestamps === 'segment',
      chunk_length_s: getProfile(request.profileId)?.chunkLengthSeconds ?? 30,
      stride_length_s: getProfile(request.profileId)?.strideLengthSeconds ?? 5,
    });

    if (isCancelled(request.requestId)) {
      post({ protocol: 1, type: 'CANCELLED', requestId: request.requestId });
      return;
    }

    postProgress(request.requestId, {
      phase: 'finalize',
      status: 'completed',
      ratio: 1,
    });

    const result = normalizeResult(raw, durationSeconds);
    post({
      protocol: 1,
      type: 'RESULT',
      requestId: request.requestId,
      result,
    });

    // Keep timing in diagnostics for a follow-up GET_DIAGNOSTICS if needed.
    void createDiagnostics({
      modelProfileId: slot.profileId,
      modelRevision: slot.modelRevision,
      requestedRuntime: request.runtimePreference,
      effectiveRuntime: slot.effectiveRuntime,
      fallbackReasonCode: slot.fallbackReasonCode,
      preparationMs: slot.preparationMs,
      inferenceMs: Math.round(performance.now() - inferenceStarted),
      audioDurationSeconds: durationSeconds,
    });
  } catch (error) {
    postError(request.requestId, asWorkerError(error, 'infer'));
  }
}

function asWorkerError(error: unknown, phase: string): WorkerError {
  if (error && typeof error === 'object' && 'code' in error) {
    return error as WorkerError;
  }
  const message = error instanceof Error ? error.message : 'unknown';
  if (/memory|oom/i.test(message)) {
    return makeError('OUT_OF_MEMORY', phase, true);
  }
  if (/download|fetch|network/i.test(message)) {
    return makeError('MODEL_DOWNLOAD_FAILED', phase, true);
  }
  return {
    ...makeError('INFERENCE_FAILED', phase, true),
    diagnostic: { reason: 'library_error' },
  };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (!request || request.protocol !== 1) {
    post({
      protocol: 1,
      type: 'ERROR',
      requestId: request?.requestId ?? 'unknown',
      error: makeError('PROTOCOL_UNSUPPORTED', 'prepare', false),
    });
    return;
  }

  switch (request.type) {
    case 'PREPARE':
      void handlePrepare(request);
      break;
    case 'TRANSCRIBE':
      void handleTranscribe(request);
      break;
    case 'CANCEL':
      cancelledRequestIds.add(request.targetRequestId);
      post({ protocol: 1, type: 'CANCELLED', requestId: request.requestId });
      break;
    case 'DISPOSE':
      active = null;
      preparing = null;
      cancelledRequestIds = new Set();
      post({
        protocol: 1,
        type: 'DIAGNOSTICS',
        requestId: request.requestId,
        diagnostics: createDiagnostics(),
      });
      break;
    case 'GET_DIAGNOSTICS':
      post({
        protocol: 1,
        type: 'DIAGNOSTICS',
        requestId: request.requestId,
        diagnostics: createDiagnostics({
          modelProfileId: active?.profileId,
          modelRevision: active?.modelRevision,
          effectiveRuntime: active?.effectiveRuntime,
          preparationMs: active?.preparationMs,
          fallbackReasonCode: active?.fallbackReasonCode,
        }),
      });
      break;
    default:
      postError((request as WorkerRequest).requestId, makeError('INTERNAL', 'prepare', false));
  }
};
