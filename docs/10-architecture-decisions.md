# Architecture Decisions

This file records accepted baseline decisions. A change that alters a boundary, privacy guarantee, release invariant, or runtime contract requires a new ADR entry rather than silently editing history.

## ADR-001 — Standalone source repository

**Decision:** Maintain the transcriber in `YurMil/ws-speech-text` and publish a static release artifact consumed by CAD AutoScript.

**Rationale:** Keeps heavy AI dependencies and release cadence independent from Docusaurus, supports isolated CI and rollback, and prevents model/runtime code from entering the main site bundle.

**Consequences:** Requires artifact packaging, checksums, host sync tooling, and coordinated releases.

## ADR-002 — Same-origin iframe integration

**Decision:** Embed the built application under `static/utility-apps/whisper-transcriber/` through the existing CAD AutoScript utility shell.

**Rationale:** Reuses host routing, SEO, comments, reactions, access notices, and fullscreen behavior while isolating the utility bundle.

**Consequences:** Microphone access requires both response Permissions Policy and iframe delegation. Host messages require strict origin/source validation.

## ADR-003 — Web Worker owns inference

**Decision:** Transformers.js, ONNX Runtime initialization, model preparation, and inference run only in a module Web Worker.

**Rationale:** Avoids blocking React/UI, creates a hard-cancellation boundary, and isolates model lifecycle.

**Consequences:** Requires typed protocol, transferable buffers, Worker crash recovery, and explicit diagnostics.

## ADR-004 — WASM is mandatory; WebGPU is optional

**Decision:** WASM is the compatibility baseline. WebGPU is an acceleration profile selected only after successful runtime initialization and must fall back to WASM.

**Rationale:** WebGPU availability and implementation quality vary. A capability check alone does not guarantee successful model execution.

**Consequences:** Both paths are tested and released. Diagnostics record requested/effective runtime and fallback reason.

## ADR-005 — Canonical mono 16 kHz audio contract

**Decision:** All file and microphone input is decoded, deterministically downmixed, resampled, and validated into finite mono 16 kHz `Float32Array` samples before inference.

**Rationale:** Prevents codec/channel/sample-rate differences from leaking into model calls and enables deterministic tests.

**Consequences:** Audio normalization is a first-class subsystem with memory limits and fixtures.

## ADR-006 — Record then transcribe for version 1

**Decision:** Microphone support records a bounded session, then runs the shared batch pipeline. Live rolling transcription is deferred.

**Rationale:** Reduces complexity in chunk overlap, partial hypotheses, AudioWorklet support, memory/backpressure, and cancellation.

**Consequences:** Not suitable for real-time captions in version 1.

## ADR-007 — Manifest-controlled models

**Decision:** The UI selects only reviewed profiles from a versioned manifest containing immutable model revision, device/dtype, required files, limits, and licenses.

**Rationale:** Prevents arbitrary model/network execution and enables reproducibility, integrity checks, and rollback.

**Consequences:** Adding or changing a model profile is a reviewed release operation.

## ADR-008 — One resident pipeline

**Decision:** Version 1 keeps at most one active prepared pipeline in a Worker.

**Rationale:** Browser model/tensor memory is substantial, particularly on integrated GPUs and mobile devices.

**Consequences:** Switching incompatible profiles may require disposal and re-preparation.

## ADR-009 — Content is memory-only by default

**Decision:** Audio, filenames, transcript text, segments, and user edits are not persisted or transmitted by default.

**Rationale:** Supports the core privacy proposition and minimizes breach/retention surface.

**Consequences:** Users must explicitly download results they wish to retain. Browser refresh loses the session.

## ADR-010 — No share-link support in version 1

**Decision:** The application does not announce CAD AutoScript `?calc=` share support.

**Rationale:** Transcript-derived state must not enter URLs, bookmarks, server logs, chat messages, or analytics referrers.

**Consequences:** Non-sensitive setting sharing may be considered later after a separate review.

## ADR-011 — Controlled first-party model origin preferred

**Decision:** Prefer a versioned first-party model asset origin for production. Remote Hugging Face Hub delivery remains an explicitly approved alternative.

**Rationale:** First-party delivery offers tighter CSP, cache headers, availability control, and rollback.

**Consequences:** Storage/bandwidth costs and license obligations become project responsibilities.

## ADR-012 — Artifact-based host integration

**Decision:** CAD AutoScript consumes a pinned release archive verified with SHA-256 and an internal manifest; it does not build this repository as part of the site build.

**Rationale:** Separates dependency graphs, avoids model/runtime downloads in host CI, and makes rollback deterministic.

**Consequences:** Host sync tooling must reject unsafe archives, missing assets, development URLs, and checksum mismatches.

## ADR-013 — Hard cancellation by Worker termination

**Decision:** Cooperative cancellation is attempted, but immediate reliable cancellation may terminate and recreate the Worker.

**Rationale:** Inference libraries may not expose interruption at every execution point.

**Consequences:** Prepared pipeline state is lost and may require reloading from cache.

## ADR-014 — Content-free observability only

**Decision:** Diagnostics and optional telemetry use allowlisted structural/runtime values and stable error codes only.

**Rationale:** Raw errors and detailed session metadata can leak filenames, URLs, model internals, or transcript content.

**Consequences:** Support tooling must rely on build/profile/runtime/cache/timing diagnostics rather than raw user data.

## ADR template

```md
## ADR-NNN — Title

**Status:** Proposed | Accepted | Superseded

**Context:**

**Decision:**

**Alternatives:**

**Consequences:**

**Security/privacy impact:**

**Migration/rollback:**
```
