# Testing, Observability, and Release Operations

## 1. Test strategy

Testing is divided into deterministic unit tests, Worker/protocol integration tests, browser end-to-end tests, model smoke tests, privacy/security tests, accessibility checks, and release artifact verification.

Model downloads should not run in every unit-test job. Use small fixtures, mocks, cached scheduled jobs, and explicit real-model smoke tests.

## 2. Unit tests

### Audio

- mono/stereo/multichannel downmix;
- common and unusual sample-rate conversion;
- sample-count and duration tolerance;
- finite-value validation;
- limits and cancellation;
- silent, quiet, clipped, corrupt, and empty inputs.

### Export

- TXT encoding and line endings;
- SRT numbering and timestamp formatting;
- WebVTT header and cue formatting;
- overlapping/invalid segments rejected or repaired by documented policy;
- transcript text treated as plain text.

### State machine

- only valid transitions;
- replacement input cancels active job;
- clear resets sensitive state;
- stale Worker results ignored;
- fallback and retry behavior.

### Manifest/profile

- schema validation;
- unknown enum rejection;
- immutable revision required;
- supported device/dtype combinations;
- size and duration limits.

## 3. Worker integration tests

Use a real module Worker where the test runner supports it and a fake inference adapter otherwise.

Test:

- single-flight preparation;
- request correlation;
- progress ordering;
- transferable audio buffer;
- duplicate/stale messages;
- cooperative and hard cancellation;
- Worker crash recovery;
- WebGPU failure to WASM fallback;
- pipeline replacement on profile change;
- content-free diagnostics and errors.

## 4. Browser matrix

Minimum release matrix:

- Windows + current Chrome/Edge: WASM and WebGPU;
- Windows + current Firefox: WASM;
- macOS + current Safari: supported profile/runtime only;
- Android Chromium: file flow and memory-limited behavior;
- iOS Safari: explicit support/fallback decision;
- denied microphone permission;
- unavailable microphone;
- offline cold cache and offline warm cache;
- low-memory or simulated pressure scenarios.

Exact minimum versions are recorded before implementation and updated per release.

## 5. Real-model smoke corpus

Maintain a non-sensitive, redistributable corpus with:

- English clean speech;
- Russian clean speech;
- mixed technical vocabulary;
- moderate noise;
- silence and music-only negative samples;
- short and multi-minute files;
- different codecs/sample rates/channels.

Store expected qualitative outcomes and optional word-error-rate baselines. Accuracy tests should detect major regression, not claim universal transcription quality.

## 6. Performance benchmarks

Record by browser/device/profile/runtime:

- cold model transfer time;
- warm preparation time;
- inference time;
- real-time factor (`inference seconds / audio seconds`);
- peak memory when measurable;
- UI long tasks;
- cancellation latency;
- artifact and model bytes.

Set release budgets after prototype measurements. Do not invent hard budgets before representative tests.

## 7. Accessibility

Automated checks plus manual keyboard and screen-reader review:

- all controls reachable and labelled;
- record state announced;
- progress updates throttled for assistive technology;
- errors connected to affected controls;
- focus restored after modal/error/cancellation;
- 200% zoom and narrow iframe layout;
- reduced-motion preference;
- contrast and non-color status indicators.

## 8. Privacy regression test

Use unique marker text in filename, audio speech, transcript edit, and export name. Exercise success, cancellation, decode error, model error, and clear. Search network payloads, URL, console, telemetry, storage, cache metadata, and host messages. Any marker leakage fails release.

## 9. Security-header tests

In a production-like preview verify:

- effective CSP;
- effective Permissions Policy;
- iframe delegation;
- Worker/WASM MIME and loading;
- exact model origins and redirects;
- CORS behavior;
- immutable/revalidation cache headers;
- no unexpected third-party requests;
- framing restricted to intended same-origin host.

## 10. Observability

Diagnostics available locally to the user/support:

- app version/build ID;
- model profile and immutable revision;
- Transformers.js version;
- requested/effective runtime;
- fallback reason code;
- cache state;
- preparation/inference timings;
- audio duration and sample count, but not content;
- stable error codes.

A “Copy diagnostics” action must redact sensitive values and be covered by tests.

Remote metrics, if enabled, are coarse, content-free, allowlisted, and optional. Never transmit transcript or raw library exceptions.

## 11. CI pipeline

Every PR:

```text
install --frozen-lockfile
lint
typecheck
unit tests
Worker integration tests
production build
artifact verification
license/SBOM generation check
dependency audit
```

Scheduled or release jobs:

```text
real-model browser smoke tests
cold/warm cache tests
performance matrix
privacy marker test
security-header preview test
accessibility review checklist
```

## 12. Artifact verification

Fail if:

- `app.html` missing;
- asset reference missing or absolute incorrectly;
- localhost/dev server reference exists;
- source map committed unintentionally;
- Worker/WASM missing;
- manifest/checksum mismatch;
- unexpected executable/file type present;
- archive contains traversal or symlink entries;
- package/model version metadata absent;
- artifact exceeds reviewed size threshold.

## 13. Release process

1. Merge reviewed source and docs.
2. Create signed/protected version tag.
3. Build from clean lockfile.
4. Generate manifest, checksums, SBOM, licenses, and archive.
5. Run release test matrix.
6. Publish immutable GitHub release asset.
7. Update CAD AutoScript pinned release/checksum in a separate PR.
8. Validate Vercel preview including headers and model origin.
9. Publish route privately/unlisted.
10. Run final smoke/privacy checks.
11. Enable catalog entry.

## 14. Rollback

- remove catalog exposure;
- restore previous host artifact pin;
- restore previous model manifest;
- disable WebGPU/microphone profile flags if needed;
- restore restrictive headers;
- verify unrelated CAD AutoScript utilities remain operational.

Keep at least the previous known-good app and model releases available.

## 15. Release checklist

- [ ] exact package and model revisions recorded;
- [ ] model license reviewed;
- [ ] unit/integration/browser tests pass;
- [ ] WASM independent path passes;
- [ ] WebGPU fallback passes;
- [ ] privacy marker test passes;
- [ ] accessibility review passes;
- [ ] CSP/Permissions Policy verified from responses;
- [ ] cold/warm cache behavior verified;
- [ ] artifact/checksums/SBOM verified;
- [ ] rollback rehearsed;
- [ ] public copy accurately describes local processing and model download.
