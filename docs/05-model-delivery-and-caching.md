# Model Delivery and Caching

## 1. Goals

Model delivery must be reproducible, transparent, cacheable, compatible with CSP/CORS, and independently rollable back. The UI must not hide the first-use transfer cost.

## 2. Versioned model manifest

The application consumes a reviewed manifest rather than hardcoded mutable IDs:

```json
{
  "schemaVersion": 1,
  "manifestVersion": "2026-07-01",
  "profiles": [
    {
      "id": "whisper-tiny-multilingual-wasm",
      "modelId": "approved/model-id",
      "revision": "immutable-commit-sha",
      "device": "wasm",
      "dtype": "approved-dtype",
      "approximateDownloadBytes": 75000000,
      "chunkLengthSeconds": 30,
      "strideLengthSeconds": 5
    }
  ]
}
```

Each release records the exact Transformers.js version, model revision, required files, licenses, expected bytes, supported devices, and integrity/checksum strategy.

## 3. Delivery options

### A. Controlled first-party model origin — preferred production option

Serve versioned model files through a dedicated first-party path or asset origin:

```text
/models/whisper/<manifest-version>/<profile>/...
```

Advantages:

- narrow CSP;
- controlled cache headers;
- stable URLs;
- independent rollback;
- easier availability monitoring;
- no third-party redirect surprises.

Costs include storage, bandwidth, model license compliance, and a publication pipeline.

### B. Hugging Face Hub

Suitable for prototyping or approved production use only when:

- immutable revision is pinned;
- exact network redirects/origins are captured;
- CSP and CORS are verified in preview;
- model repository license is reviewed;
- rollback does not depend on a mutable branch;
- operational dependence on external availability is accepted.

Do not allow arbitrary user model URLs.

### C. Bundling weights inside the app release

Not recommended. It makes every utility release large, couples app and model rollback, and complicates deployment limits and cache invalidation.

## 4. Cache layers

Possible layers include HTTP cache, Cache Storage used by the runtime, and browser implementation-specific caches. The application treats cache state as best effort.

User-facing states:

- `cold`: required files not found;
- `partial`: some files cached or interrupted;
- `warm`: required files appear available;
- `unknown`: browser/runtime cannot determine reliably.

Never promise permanent offline use. Browsers may evict data or users may clear storage.

## 5. Cache headers

For immutable versioned model files:

```text
Cache-Control: public, max-age=31536000, immutable
```

For mutable manifests or rollout controls:

```text
Cache-Control: public, max-age=0, must-revalidate
```

Do not publish new bytes under an existing immutable URL.

## 6. Integrity and publication

Release tooling should generate:

- file list;
- byte sizes;
- SHA-256 checksums;
- model revision and source;
- license metadata;
- publication timestamp;
- manifest version.

The publication job uploads to a temporary versioned path, verifies bytes from the serving origin, then activates the manifest. Failed uploads never replace the active manifest.

## 7. Download progress

Progress is aggregated from known required files. UI displays:

- current phase;
- downloaded and total bytes when known;
- per-file labels without sensitive query strings;
- cache-hit indication;
- clear warning before a large optional profile download.

If content length is unavailable, show indeterminate progress instead of fabricated percentages.

## 8. Failure handling

Stable conditions include:

- offline before first use;
- DNS/network error;
- CORS denial;
- CSP denial;
- missing file;
- partial/corrupt cache;
- integrity mismatch;
- out of storage;
- runtime initialization failure after successful download.

Retries must be bounded. An integrity mismatch disables the profile until a clean refetch or corrected manifest is available.

## 9. Storage controls

A diagnostics/settings panel may show model profile, approximate stored size, revision, and a user action to clear application-managed caches where technically possible. It must explain that browser-managed caches may also require browser settings.

Do not clear unrelated site caches.

## 10. Rollback

Rollback changes the active manifest to the previous immutable profile/version. Existing cached files may remain but are no longer selected. The app and model rollbacks are independent:

- app regression: restore previous static app artifact;
- model regression: restore previous manifest/profile;
- origin outage: disable affected profiles or switch approved origin;
- WebGPU regression: disable WebGPU profile while retaining WASM.

## 11. Release gates

Before activating a model profile:

- verify model license and notices;
- test cold and warm cache;
- inspect exact network origins;
- validate CSP/CORS/MIME/range behavior;
- test interrupted download recovery;
- verify checksums;
- benchmark memory and latency;
- test rollback to prior manifest;
- confirm no model fetch occurs during CAD AutoScript site build.
