# Client-Side Whisper Transcriber

**Status:** minimal prototype + architecture specification  
**Source repository:** `YurMil/ws-speech-text`  
**Integration target:** `YurMil/cadautoscript.com`  
**Planned public route:** `/utilities/whisper-transcriber/`

This repository defines a production-grade, fully client-side speech-to-text application built with Vite, React, TypeScript, Transformers.js, ONNX Runtime Web, Web Workers, WASM, and optional WebGPU acceleration.

## Run the prototype

```bash
pnpm install
pnpm dev        # development server
pnpm build      # production bundle in dist/
pnpm verify     # audit dist/ the way the publishing host will
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

## Host integration status

These host-side prerequisites are addressed by the CAD AutoScript publication change:

- capability delegation is now per utility (`UtilityPageConfig.iframeAllow`), and the transcriber is the only utility that receives `microphone 'self'`;
- `Permissions-Policy` is relaxed to `microphone=(self)` only on `/utilities/whisper-transcriber/*` and `/utility-apps/whisper-transcriber/*`; the site default stays `microphone=()`;
- `connect-src` allows the Hugging Face Hub origins the pinned model is fetched from.

Model delivery uses the Hub with an immutable revision pinned in `src/inference/profiles.ts`. A controlled first-party origin remains the preferred long-term option; the pin, the CSP allowlist, and the artifact manifest are what make the current arrangement rollback-safe.

## Release and publication pipeline

**Merging to `main` publishes the utility.** No tag required:

1. `.github/workflows/release.yml` builds the bundle, runs `pnpm test` and `scripts/verify-artifact.mjs`, packages `whisper-transcriber-<tag>.zip` and attaches it to a GitHub release with its SHA-256.
2. It sends a `whisper-transcriber-release` `repository_dispatch` to `YurMil/cadautoscript.com` using the `SITE_DISPATCH_TOKEN` secret.
3. That repository's `sync-whisper-transcriber` workflow downloads the archive, refuses it unless the checksum matches, re-audits every file, republishes `static/utility-apps/whisper-transcriber/`, runs typecheck/lint/build, and opens a pull request.

Nothing reaches production without that pull request being reviewed.

### What triggers a release, and what does not

Only merges that touch the application release — `src/`, `scripts/`, `index.html`, the package manifest, lockfile or build config. A README or workflow-only change does not, or every documentation fix would raise another pull request on the site.

Automatic builds are tagged `v<version>-build.<run>` and marked as prereleases, so hand-cut versions stay easy to find among them. The run number, rather than a version bump committed back to the repository, is what keeps them distinct — writing to `main` from the workflow would retrigger it.

For a named version, tag it explicitly:

```bash
git tag v0.3.0
git push origin v0.3.0
```

The host never builds this app and never downloads model weights. If the secret is absent the release still succeeds, and the host sync can be started manually from its Actions tab with the tag.

### Artifact contents

```text
app.html          # entry the utility shell iframes
index.html        # same document, so the directory URL also works
assets/*          # hashed JS, CSS and the ONNX Runtime WASM
build-info.json   # version, git build id, build time
manifest.json     # written by the host: entry, asset list, SHA-256 per file
```

`scripts/verify-artifact.mjs` runs the same audit the host applies — no symlinks, no path traversal, no source maps, no development references, and the entry document may only reference packaged relative assets — so a bad bundle fails here rather than in the host pipeline.

## Definition of done

The application is complete when it builds independently, remains responsive during inference, works through WASM when WebGPU is unavailable or fails, enforces the audio contract, passes privacy/network inspection, handles cancellation and recovery, works inside the production iframe policy, exports valid transcript formats, and can be rolled back without relying on mutable remote assets or stale browser caches.
