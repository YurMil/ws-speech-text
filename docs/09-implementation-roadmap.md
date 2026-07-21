# Implementation Roadmap

## Guiding rule

Deliver a reliable file-transcription path first, then microphone capture, then CAD AutoScript exposure. Do not combine architecture setup, model experimentation, security-policy changes, and public launch in one PR.

## Phase 0 — Decisions and spikes

Decide and record:

- supported browser versions;
- pinned Transformers.js release;
- approved tiny/base model IDs and immutable revisions;
- WASM and WebGPU dtype profiles;
- first-party versus Hub model delivery;
- input byte/duration limits;
- initial UI languages;
- telemetry policy;
- model license and redistribution requirements.

Spikes:

- tiny model preparation and one known WAV transcription in a module Worker;
- WebGPU initialization and forced WASM fallback;
- actual model request origin trace;
- representative Windows memory/latency measurement;
- Vercel iframe microphone-policy preview.

**Exit:** technical choices are written as ADRs and no blocker remains unknown.

## Phase 1 — Repository foundation

- initialize Vite, React, TypeScript, pnpm, ESLint, Vitest;
- define source layout and import boundaries;
- add CI for lint, typecheck, tests, and build;
- add artifact manifest/checksum tooling;
- add dependency/license/SBOM tooling;
- create accessible application shell and error boundary;
- add build/version diagnostics.

**Exit:** empty production app builds as a verified static artifact.

## Phase 2 — Audio file pipeline

- file picker and drag/drop;
- byte/type validation;
- browser decode adapter;
- deterministic downmix and 16 kHz resampling;
- duration/sample validation;
- cancellation and cleanup;
- fixture-based unit tests;
- audio metadata UI without persistent content storage.

**Exit:** supported fixtures produce validated mono 16 kHz arrays with stable errors.

## Phase 3 — Worker inference MVP

- typed Worker protocol and request manager;
- manifest/profile validation;
- single-flight pipeline manager;
- tiny WASM profile;
- preparation progress;
- transcription result normalization;
- hard cancellation and Worker recreation;
- copy and TXT export;
- real-model smoke test.

**Exit:** one uploaded file transcribes through WASM with responsive UI and deterministic cleanup.

## Phase 4 — Runtime profiles and subtitle export

- WebGPU capability and initialization path;
- automatic fallback to WASM;
- requested/effective runtime diagnostics;
- optional base profile after memory benchmarks;
- language selector and automatic detection;
- segment timestamps;
- SRT and WebVTT generation/validation;
- profile download/memory warnings.

**Exit:** runtime fallback and exports pass browser tests.

## Phase 5 — Microphone workflow

- explicit record action;
- MediaStream/MediaRecorder adapter;
- recording timer and duration cap;
- permission denied/unavailable states;
- stop and track cleanup;
- recorded Blob through shared audio pipeline;
- accessibility testing of record state;
- privacy marker tests for device/content data.

**Exit:** microphone workflow works in a standalone HTTPS preview and file flow remains available after denial.

## Phase 6 — Model delivery and cache operations

- finalize first-party or Hub delivery;
- immutable model manifest;
- exact CSP/CORS allowlist;
- cold/warm/partial cache states;
- interrupted download recovery;
- checksum/integrity verification where supported;
- cache diagnostics and clear action;
- model rollback procedure;
- license notices.

**Exit:** cold/warm/offline behavior and model rollback are verified.

## Phase 7 — Release engineering

- archive generation with `app.html`, assets, manifest, checksums, SBOM, licenses;
- artifact verifier;
- protected release workflow;
- release notes template;
- previous-known-good retention;
- CAD AutoScript sync script design and checksum pinning.

**Exit:** a release artifact can be reproduced, verified, downloaded, and rolled back.

## Phase 8 — CAD AutoScript private integration

In `cadautoscript.com`:

- add pinned artifact sync and verification;
- publish under `static/utility-apps/whisper-transcriber/`;
- add shell config and private route;
- add per-utility iframe `allow`;
- implement route-specific Permissions Policy;
- implement exact CSP model origins;
- verify Vercel header precedence;
- verify fullscreen, locale/theme context, auth notice, comments/reactions;
- keep route unlisted.

**Exit:** private production-like route passes complete integration tests.

## Phase 9 — Release acceptance

- browser matrix;
- real-model corpus regression;
- cold/warm performance matrix;
- memory and cancellation tests;
- privacy marker test;
- accessibility review;
- CSP/Permissions Policy inspection;
- incident/rollback rehearsal;
- user documentation and support diagnostics.

**Exit:** release checklist in `08-testing-observability-release.md` is complete.

## Phase 10 — Public launch

- add utility catalog entry and related tools;
- add thumbnail and OG metadata;
- add `docs/utilities/whisper-transcriber.mdx` in CAD AutoScript;
- add required host locale strings;
- enable public route/catalog exposure;
- monitor only content-free health/performance signals;
- retain immediate kill switches for model, WebGPU, microphone, and catalog exposure.

## Recommended PR sequence

1. Documentation and ADR baseline.
2. Vite/CI/artifact foundation.
3. Audio normalization with fixtures.
4. Worker WASM tiny MVP.
5. Result editor and TXT export.
6. WebGPU fallback and timestamp exports.
7. Microphone capture.
8. Model delivery/cache controls.
9. Release packaging and sync tooling.
10. CAD AutoScript private integration.
11. Security/accessibility/performance hardening.
12. Public catalog and docs.

## Backlog after version 1

- rolling-window/live transcription;
- AudioWorklet capture;
- optional translation mode;
- PWA/offline application shell;
- resumable long-audio jobs;
- transcript search/edit helpers;
- optional user-controlled local history;
- additional languages/profiles;
- speaker diarization via a separately reviewed architecture.

Each backlog item requires new privacy, performance, browser, and model decisions rather than being assumed compatible with the MVP design.
