# Client-Side Whisper Transcriber

**Status:** minimal prototype + architecture specification  
**Source repository:** `YurMil/ws-speech-text`  
**Integration target:** `YurMil/cadautoscript.com`  
**Planned public route:** `/utilities/whisper-transcriber/`

This repository defines a production-grade, fully client-side speech-to-text application built with Vite, React, TypeScript, Transformers.js, ONNX Runtime Web, Web Workers, WASM, and optional WebGPU acceleration.

## Run the prototype

```bash
pnpm install
pnpm dev
```

Open the printed local URL. First transcription downloads the multilingual Whisper tiny ONNX model from Hugging Face Hub (~77 MB) and caches it in the browser.

**Large audio/video:** files are probed with Mediabunny, then transcribed in a conveyor of ~30s mono 16 kHz windows (5s overlap). Only one PCM window is held at a time; the Worker keeps a single prepared model across windows. Short clips still use a one-shot decode path.

Audio decoding, normalization, inference, transcript formatting, and export run in the browser. No transcription backend is required. The built application is published as a versioned static artifact and embedded into CAD AutoScript through its existing same-origin utility iframe architecture.

## Target architecture

```text
Audio file / microphone
        |
        v
Decode -> downmix -> resample to mono 16 kHz Float32Array
        |
        v
Typed Worker client
        |
        v
Module Web Worker
  - model manifest
  - Transformers.js pipeline
  - ONNX Runtime Web
  - WebGPU with WASM fallback
        |
        v
Transcript + timestamp segments
        |
        v
Copy / TXT / SRT / WebVTT export
```

The Docusaurus host owns navigation, SEO, authentication notices, comments, reactions, and the common utility shell. This repository owns the transcriber UI, audio pipeline, inference Worker, tests, diagnostics, and release artifact.

## Version 1 scope

- audio-file upload;
- record-then-transcribe microphone workflow;
- multilingual Whisper tiny as the default profile;
- optional multilingual Whisper base profile;
- automatic language detection plus explicit Russian and English selection;
- WASM compatibility runtime;
- optional WebGPU acceleration with automatic fallback;
- model download and preparation progress;
- cancellation and session clearing;
- transcript text and timestamped segments;
- copy, TXT, SRT, and WebVTT export;
- content-free diagnostics for runtime, model revision, cache state, and performance.

Deferred from version 1: live rolling transcription, speaker diarization, cloud fallback, transcript accounts/history, collaborative editing, arbitrary user models, and medium/large Whisper profiles.

## Documentation

1. [Product specification](docs/01-product-specification.md)
2. [System architecture](docs/02-system-architecture.md)
3. [Runtime and Worker contracts](docs/03-runtime-and-worker-contracts.md)
4. [Audio processing](docs/04-audio-processing.md)
5. [Model delivery and caching](docs/05-model-delivery-and-caching.md)
6. [CAD AutoScript integration](docs/06-site-integration.md)
7. [Security and privacy](docs/07-security-and-privacy.md)
8. [Testing, observability, and release](docs/08-testing-observability-release.md)
9. [Implementation roadmap](docs/09-implementation-roadmap.md)
10. [Architecture decisions](docs/10-architecture-decisions.md)
11. [References](docs/references.md)

## Planned repository structure

```text
ws-speech-text/
  README.md
  CONTRIBUTING.md
  docs/
  package.json
  index.html
  src/
    app/
    audio/
    bridge/
    components/
    export/
    inference/
    state/
    styles/
    telemetry/
    workers/
  scripts/
  public/
  tests/
  dist/              # generated, not committed
```

## Core invariants

1. Inference never runs on the React/UI thread.
2. Raw waveform inference always receives finite mono 16 kHz `Float32Array` samples.
3. File and microphone inputs use the same normalization pipeline.
4. WASM remains a tested fallback even when WebGPU is available.
5. Package and model revisions are immutable and recorded in the artifact manifest.
6. Audio, filenames, transcript text, segments, and user edits never enter URLs, analytics, logs, host messages, or persistent storage by default.
7. Microphone permission is requested only after an explicit user action.
8. Cancellation releases the active Worker, MediaStream tracks, AudioContext, and Blob URLs.
9. CAD AutoScript never bundles Transformers.js or model weights into its main Docusaurus bundle.
10. A release is not public until browser, privacy, accessibility, performance, CSP, Permissions Policy, and rollback gates pass.

## Important host integration blockers

The current CAD AutoScript host configuration must be changed before microphone release:

- global `Permissions-Policy` currently denies microphone access;
- the iframe currently delegates camera only;
- remote Hugging Face model origins are not currently allowed by `connect-src`;
- capability delegation should become per utility rather than globally granting microphone access.

The preferred production model-delivery option is a controlled, versioned first-party origin. Remote Hub delivery may be used only with immutable revisions, an exact CSP/CORS allowlist, verified redirects, and tested rollback behavior.

## Release artifact

A release should contain:

```text
app.html
assets/*
artifact-manifest.json
checksums.json
sbom.spdx.json
LICENSES/
```

The CAD AutoScript sync process downloads a pinned release archive, verifies SHA-256 checksums, rejects unsafe paths and development URLs, and atomically publishes the artifact under:

```text
static/utility-apps/whisper-transcriber/
```

## Definition of done

The application is complete when it builds independently, remains responsive during inference, works through WASM when WebGPU is unavailable or fails, enforces the audio contract, passes privacy/network inspection, handles cancellation and recovery, works inside the production iframe policy, exports valid transcript formats, and can be rolled back without relying on mutable remote assets or stale browser caches.
