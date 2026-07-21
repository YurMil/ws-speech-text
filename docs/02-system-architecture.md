# System Architecture

## 1. Architectural style

The application is a standalone static Vite/React SPA. It is developed and released from `YurMil/ws-speech-text`, then embedded by CAD AutoScript as a same-origin iframe.

The host and utility have a strict boundary:

| CAD AutoScript host owns | Transcriber owns |
|---|---|
| Route, SEO, shell, comments, reactions | Audio capture and file input |
| Authentication/access notices | Decode, downmix, resample, validation |
| Site navigation and localization shell | Model selection and preparation |
| Deployment headers | Worker lifecycle and inference |
| Aggregate launch metrics | Transcript UI and exports |

The host must not import Transformers.js, ONNX Runtime, model weights, or transcriber domain code.

## 2. Runtime components

```text
Docusaurus utility page
  |
  +-- same-origin iframe
        |
        +-- React application
        |     +-- input and recording UI
        |     +-- application state machine
        |     +-- transcript and export UI
        |     +-- diagnostics
        |
        +-- audio subsystem
        |     +-- browser decode adapter
        |     +-- channel mixer
        |     +-- resampler
        |     +-- sample validator
        |
        +-- inference bridge
              +-- typed request manager
              +-- module Web Worker
                    +-- profile manifest
                    +-- Transformers.js
                    +-- ONNX Runtime Web
                    +-- WebGPU/WASM runtime selection
                    +-- cached pipeline singleton
```

## 3. Source layout

```text
src/
  app/                 # state machine, composition, error boundary
  audio/               # capture, decode, normalization, limits
  bridge/              # host messages, content-free context only
  components/          # presentation and accessible controls
  export/              # TXT, SRT, WebVTT generation
  inference/           # profiles, runtime policy, result mapping
  state/               # Zustand or reducer-based state
  telemetry/           # allowlisted content-free events
  workers/             # worker entry, protocol, pipeline manager
  styles/
```

Domain and protocol modules must not depend on React. UI components must not contain inference initialization or audio algorithms.

## 4. Main-thread responsibilities

- user interaction and rendering;
- file and microphone selection;
- permission request after user gesture;
- decoding through browser media APIs where necessary;
- normalized audio transfer to the Worker;
- state transitions, progress presentation, cancellation, exports;
- lifecycle cleanup.

The main thread must never instantiate the ASR pipeline or run model inference.

## 5. Worker responsibilities

- resolve a validated model profile;
- initialize Transformers.js and ONNX Runtime;
- select effective device and dtype;
- prepare and cache one active pipeline per compatible profile;
- publish structured progress;
- run inference;
- normalize library output into application result types;
- emit stable errors without content;
- dispose resources when requested or terminated.

## 6. Pipeline manager

Use a single-flight initializer keyed by a profile fingerprint:

```text
model id + immutable revision + device + dtype + library version
```

Concurrent prepare/transcribe requests for the same fingerprint share one preparation promise. Incompatible profile changes dispose or replace the existing pipeline according to memory policy.

Do not keep tiny and base pipelines resident simultaneously in version 1.

## 7. Runtime selection

1. Read profile capabilities.
2. If WebGPU requested, test browser API availability.
3. Request adapter/device.
4. Initialize the exact ONNX/Transformers pipeline.
5. Run a small warm-up or readiness operation.
6. If any stage fails with a recoverable capability/runtime error, dispose partial resources and initialize WASM.
7. Report requested runtime, effective runtime, and fallback reason code.

Feature detection alone is insufficient; successful runtime initialization is the authority.

## 8. State management

Recommended state slices:

- `session`: source type, duration, normalized audio metadata;
- `settings`: model profile, language, task, timestamps, runtime preference;
- `job`: request ID, phase, progress, cancellation state;
- `result`: transcript, segments, warnings;
- `diagnostics`: build, model revision, runtime, cache and timing data;
- `ui`: panels, notices, editor state.

Persist only non-sensitive preferences after review. Never persist audio or transcripts by default.

## 9. Error model

Errors contain:

```ts
type AppError = {
  code: string;
  phase: 'input' | 'decode' | 'normalize' | 'prepare' | 'infer' | 'export';
  recoverable: boolean;
  userMessageKey: string;
  diagnostic?: Record<string, string | number | boolean>;
};
```

Diagnostic values are allowlisted and content-free. Raw exception messages from model libraries are not sent to analytics.

## 10. Resource lifecycle

A session owns:

- optional MediaStream;
- optional MediaRecorder buffers;
- AudioContext;
- source Blob/Object URL;
- normalized Float32Array;
- Worker request;
- transcript result.

`Clear session`, navigation, replacement input, and fatal errors must stop tracks, close audio contexts, revoke URLs, detach listeners, cancel/terminate work, and release arrays/results.

## 11. Build boundary

The Vite output uses `base: './'`, hashed assets, module Workers, and no development URLs. Release tooling generates a manifest, checksums, SBOM, and archive. CAD AutoScript consumes only this static artifact.

## 12. Scalability path

Future versions can add rolling-window transcription, AudioWorklet capture, shared model services, or PWA support without changing the host boundary. These are separate architecture decisions and must not be prebuilt into version 1 complexity.
