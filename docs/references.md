# References

This document lists primary technical sources to verify during implementation and upgrades. Pin exact versions/revisions in the application manifest and release notes; do not treat examples or mutable branches as permanent contracts.

## Transformers.js and models

- Transformers.js documentation and repository: `https://github.com/huggingface/transformers.js`
- Hugging Face Transformers.js documentation: `https://huggingface.co/docs/transformers.js/`
- Transformers.js package: `@huggingface/transformers`
- Hugging Face Hub model repositories and model cards for the selected Whisper ONNX profiles
- Whisper model and paper references from OpenAI

Implementation note: older examples may use `@xenova/transformers` and `Xenova/*` model IDs. New work should validate the current package namespace, current APIs, browser runtime support, selected model repository, immutable revision, files, dtypes, and license.

## ONNX Runtime Web

- ONNX Runtime Web documentation: `https://onnxruntime.ai/docs/get-started/with-javascript/web.html`
- ONNX Runtime JavaScript repository: `https://github.com/microsoft/onnxruntime`
- WebGPU execution provider documentation and compatibility notes
- WASM deployment, threading, SIMD, MIME, and CSP requirements for the pinned release

## Browser APIs

- MDN Web Workers API
- MDN WebGPU API
- MDN MediaDevices `getUserMedia()`
- MDN MediaRecorder API
- MDN Web Audio API and AudioContext
- MDN OfflineAudioContext
- MDN Cache API and StorageManager
- MDN Blob and URL object URLs
- MDN `window.postMessage()` security guidance

## Web platform security

- Content Security Policy Level 3
- Permissions Policy specification and MDN guidance
- iframe `allow` / Permissions Policy delegation
- Subresource Integrity limitations and applicability
- CORS and Fetch specifications
- Trusted Types, if introduced later

## Build and deployment

- Vite documentation: Workers, static assets, `base`, production build, and library compatibility
- React documentation
- TypeScript documentation
- Vitest documentation
- Playwright documentation
- Vercel headers and cache-control documentation
- GitHub Actions security hardening and artifact provenance guidance
- SPDX SBOM specification

## Host repositories

- Source repository: `https://github.com/YurMil/ws-speech-text`
- Integration target: `https://github.com/YurMil/cadautoscript.com`

Relevant CAD AutoScript implementation areas:

- `src/components/Utilities/UtilityShellPage.tsx`
- `src/components/Utilities/createUtilityPage.tsx`
- `src/data/utilityShellPages.tsx`
- `src/data/utilities.ts`
- `static/utility-apps/`
- `vercel.json`
- `.github/workflows/ci.yml`
- `dev-plans/utility-share-protocol.md`

## Verification checklist for external facts

Before an implementation or dependency-upgrade PR, confirm:

- current stable Transformers.js and ONNX Runtime Web versions;
- exact pipeline options and output shape for automatic speech recognition;
- WebGPU/WASM dtype support for selected model exports;
- actual required model files and aggregate bytes;
- immutable model commit SHA;
- model and tokenizer licenses;
- browser support and known limitations;
- CSP directives required by generated Worker/WASM code;
- exact model request origins and redirects;
- Vercel header precedence for route-specific policies;
- cache behavior from a clean browser profile;
- release artifact and SBOM contents.

## Evidence retained per release

Store or link the following in release notes/CI artifacts:

- dependency lockfile and audit result;
- artifact manifest and checksums;
- SBOM and third-party notices;
- model manifest and model-card/license snapshot;
- browser test matrix;
- privacy-marker test result;
- network-origin trace;
- cold/warm performance results;
- security-header capture;
- rollback rehearsal result.
