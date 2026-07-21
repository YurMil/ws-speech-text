# Runtime and Worker Contracts

## 1. Goals

The Worker protocol provides type safety, request correlation, structured progress, cancellation, deterministic recovery, and a strict content boundary. Protocol messages remain internal to the iframe application; transcript content is never forwarded to the CAD AutoScript host.

## 2. Protocol version

Every message includes:

```ts
type Envelope = {
  protocol: 1;
  requestId: string;
};
```

Unknown protocol versions are rejected with `PROTOCOL_UNSUPPORTED`.

## 3. Main thread to Worker

```ts
type WorkerRequest =
  | ({type: 'PREPARE'} & Envelope & {
      profileId: string;
      runtimePreference: 'auto' | 'webgpu' | 'wasm';
    })
  | ({type: 'TRANSCRIBE'} & Envelope & {
      profileId: string;
      runtimePreference: 'auto' | 'webgpu' | 'wasm';
      audio: Float32Array;
      options: {
        language: 'auto' | 'en' | 'ru';
        task: 'transcribe';
        timestamps: 'none' | 'segment';
      };
    })
  | ({type: 'CANCEL'} & Envelope & {targetRequestId: string})
  | ({type: 'DISPOSE'} & Envelope)
  | ({type: 'GET_DIAGNOSTICS'} & Envelope);
```

Transfer the audio buffer:

```ts
worker.postMessage(request, [request.audio.buffer]);
```

After transfer, the main thread must treat the original array as detached.

## 4. Worker to main thread

```ts
type WorkerResponse =
  | ({type: 'READY'} & Envelope & {diagnostics: RuntimeDiagnostics})
  | ({type: 'PROGRESS'} & Envelope & {progress: ProgressEvent})
  | ({type: 'RESULT'} & Envelope & {result: TranscriptResult})
  | ({type: 'CANCELLED'} & Envelope)
  | ({type: 'DIAGNOSTICS'} & Envelope & {diagnostics: RuntimeDiagnostics})
  | ({type: 'ERROR'} & Envelope & {error: WorkerError});
```

## 5. Model profile contract

```ts
type ModelProfile = {
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
```

Profiles are loaded from a signed/reviewed application manifest. UI input cannot provide arbitrary model IDs, revisions, file paths, or dtypes.

## 6. Progress contract

```ts
type ProgressEvent = {
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
```

Never place URLs containing tokens, user filenames, transcript snippets, or raw library events in progress payloads.

## 7. Result contract

```ts
type TranscriptSegment = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

type TranscriptResult = {
  text: string;
  segments: TranscriptSegment[];
  detectedLanguage?: string;
  durationSeconds: number;
  warnings: string[];
};
```

Validate segment ordering and finite timestamps before export. Results remain in memory unless the user explicitly downloads them.

## 8. Diagnostics contract

```ts
type RuntimeDiagnostics = {
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
```

No audio, filenames, transcript text, segment text, or user edits are permitted.

## 9. Error contract

```ts
type WorkerError = {
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
```

## 10. Cancellation

Library inference may not be synchronously interruptible. Use two levels:

1. Cooperative cancellation: mark request cancelled, suppress future progress/result, stop queued work.
2. Hard cancellation: terminate the Worker and create a fresh Worker when immediate release is required.

The UI must distinguish `cancelling` from `cancelled`. A terminated Worker invalidates its pipeline and must be prepared again.

## 11. Request manager

The main thread keeps a map of request IDs to promises and callbacks. It must:

- reject duplicate request IDs;
- ignore stale messages from a previous Worker generation;
- timeout preparation only with conservative, configurable limits;
- remove listeners and pending entries on completion;
- reject all pending requests when the Worker crashes or terminates;
- recreate the Worker through one controlled factory.

## 12. Pipeline singleton

The Worker stores one active pipeline and one preparation promise. Initialization is single-flight. A failed preparation clears the promise so retry is possible. A profile fingerprint mismatch disposes the old pipeline before loading the new one.

## 13. Transformers.js environment

Configuration is centralized in the Worker bootstrap. Example policy:

```ts
import {env, pipeline} from '@huggingface/transformers';

env.allowLocalModels = false; // remote immutable profile mode
// Or enable local models with a controlled first-party path.
```

Do not scatter environment mutations across modules. Exact options must be validated against the pinned library release.

## 14. Host bridge

Allowed host-to-utility context may include locale, theme, and build-safe feature flags. The utility verifies same origin and message source. Version 1 does not participate in CAD AutoScript's share-link protocol because transcript-derived state must never enter the URL.
