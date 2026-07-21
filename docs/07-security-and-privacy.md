# Security and Privacy

## 1. Security objective

The transcriber processes potentially confidential audio locally while allowing only the network traffic required for static application assets, approved model files, and explicitly allowlisted content-free telemetry.

“Runs locally” is an architectural property that must be verified through code review, browser network inspection, logging tests, storage inspection, and production-header tests.

## 2. Sensitive data

Sensitive content includes:

- raw and decoded audio;
- microphone recordings;
- source filenames and paths;
- transcript text and edits;
- timestamped segment text;
- clipboard/export content;
- device labels or identifiers;
- content-derived language or topic labels when tied to a session.

These values must not enter analytics, logs, crash reports, URLs, host messages, local persistent storage, service-worker queues, or network requests.

## 3. Data lifecycle

Content is memory-only by default:

1. source selected or recorded;
2. decoded and normalized;
3. transferred to Worker;
4. transcribed;
5. displayed and optionally downloaded;
6. cleared on user action, replacement, navigation, or fatal error.

Clear session terminates active work, stops MediaStream tracks, closes AudioContext, revokes Blob URLs, releases arrays/results, and resets UI state.

## 4. Threat model

Primary threats:

- accidental content telemetry;
- broad CSP allowing exfiltration;
- microphone permission granted too widely;
- compromised third-party model origin;
- mutable model revision or poisoned cache;
- malicious/corrupt audio causing memory exhaustion;
- unsafe transcript rendering or export;
- host/iframe message spoofing;
- stale Worker result applied to a new session;
- supply-chain compromise in npm/model artifacts.

## 5. Network allowlist

Expected request classes:

- same-origin application HTML, JS, CSS, Worker and WASM;
- approved immutable model/tokenizer/config files;
- existing host authentication resources;
- explicit content-free metrics if retained.

The release test records all origins from a clean profile and fails on unexpected destinations. Do not use wildcard `connect-src`.

## 6. CSP

Minimum concepts:

```text
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
connect-src 'self' <exact-model-origins>;
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline';
object-src 'none';
base-uri 'self';
frame-ancestors 'self';
```

Exact syntax depends on the final build/runtime. Remove `unsafe-eval` unless a reproduced pinned dependency requires it. Test enforced policy, not report-only policy.

## 7. Permissions Policy and iframe delegation

Microphone access requires both:

- response policy allowing microphone for self on the relevant paths;
- iframe `allow="microphone 'self'"`.

Request permission only after explicit user action. Do not request persistent device enumeration. File-only use remains available after denial.

## 8. Input security

- enforce compressed byte and decoded-duration limits;
- reject invalid/unsupported media safely;
- validate finite normalized samples;
- bound model profile/options to manifest enums;
- prevent arbitrary URLs and model IDs;
- avoid rendering transcript as HTML;
- escape text in generated subtitle formats;
- use safe local filename construction;
- handle decompression/decoder failures without retries that amplify resource use.

## 9. Worker isolation

Worker messages use discriminated unions and request IDs. Main thread ignores unknown messages, wrong protocol versions, stale Worker generations, and unexpected result types. Host bridge additionally verifies origin and source window.

Hard cancellation terminates a Worker that may still hold sensitive arrays or tensors.

## 10. Storage

Allowed persistent data after review:

- UI language;
- runtime preference;
- selected non-sensitive model profile;
- non-content accessibility preferences.

Forbidden by default:

- audio or recordings;
- transcript text/segments;
- source filenames;
- recent-file lists;
- content-derived metadata;
- job history.

Model files may be cached by runtime/browser mechanisms. The UI explains this and offers application-specific cache clearing when possible.

## 11. Telemetry

Prefer no transcriber-specific telemetry for MVP. If enabled, use a strict event allowlist such as:

- application opened;
- model preparation succeeded/failed;
- effective runtime;
- coarse duration bucket;
- coarse performance bucket;
- stable error code.

Never include raw exception strings without sanitization. Do not include exact audio duration if it could become identifying; use coarse buckets.

## 12. Supply chain

- pin package versions and lockfile;
- use Dependabot/Renovate with reviewed updates;
- generate SBOM;
- audit production dependencies;
- pin immutable model revisions;
- record licenses/notices;
- generate and verify checksums;
- prevent release workflows from accepting unreviewed arbitrary model URLs;
- protect release tags and workflows.

## 13. Transcript export

Generate downloads entirely in browser using Blob URLs. Revoke URLs after use. SRT/VTT generation validates finite, ordered timestamps and normalizes line endings. Transcript text is plain text, never interpolated into HTML.

## 14. Privacy verification

Release test procedure:

1. start with clean browser profile;
2. record and upload known marker phrases and marker filenames;
3. complete/cancel/error multiple jobs;
4. inspect all network requests, URLs, console logs, analytics payloads, local/session storage, IndexedDB, Cache Storage metadata, and host messages;
5. search for marker values;
6. fail release if any content appears outside intended in-memory UI or explicit download.

## 15. Incident and rollback

A kill switch can disable a model profile, WebGPU path, microphone capability, or public catalog entry without rebuilding unrelated utilities. Security rollback restores prior immutable app/model manifests and restrictive headers.
