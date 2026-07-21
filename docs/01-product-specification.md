# Product Specification

**Status:** Proposed  
**Product:** Client-Side Whisper Transcriber

## 1. Product goal

Provide private browser speech-to-text for engineering meetings, voice notes, field recordings, and uploaded audio without sending audio or transcript content to an application backend.

The product must make local processing understandable: users see which model is selected, approximate download size, runtime, preparation progress, cache status, and whether a network connection is required for first use.

## 2. Target users

- engineers transcribing technical notes and discussions;
- CAD AutoScript users who prefer local processing;
- users handling confidential project audio;
- multilingual users working primarily in English and Russian;
- users on managed Windows workstations with Chromium-based browsers.

## 3. Version 1 use cases

### Audio file transcription

1. User selects one supported audio file.
2. Application validates type, size, and decoded duration.
3. Audio is decoded, downmixed, resampled, and validated.
4. User selects model profile, language, task, and runtime preference.
5. Worker prepares the model and transcribes the audio.
6. User reviews, copies, edits, or exports the result.

### Microphone recording

1. User explicitly clicks Record.
2. Browser requests microphone permission.
3. UI displays recording state and elapsed time.
4. User stops the recording.
5. Recorded audio enters the same normalization and inference pipeline as an uploaded file.
6. All MediaStream tracks are stopped after capture.

### Warm-cache reuse

A returning user can prepare a previously cached model without redownloading all immutable files. The UI must never promise permanent offline availability because the browser may evict caches.

## 4. Functional requirements

### Input

- accept common browser-decodable formats such as WAV, MP3, M4A/AAC, OGG, WebM, and FLAC where supported;
- reject unsupported or undecodable files with a stable error code;
- configurable limits for input bytes and decoded duration;
- no automatic microphone prompt on page load;
- one active content session in version 1.

### Model profiles

- default multilingual Whisper tiny profile;
- optional multilingual Whisper base profile;
- visible model description, expected quality tier, transfer estimate, memory warning, and runtime compatibility;
- immutable model revision stored in a manifest;
- profile unavailable state when required capabilities are missing.

### Runtime

- WASM is mandatory and tested;
- WebGPU is optional and selected only after adapter/device/runtime initialization succeeds;
- automatic fallback from WebGPU to WASM;
- diagnostics show requested and effective runtime;
- no silent fallback when it materially changes expected performance: notify the user.

### Transcription settings

- task: transcribe;
- language: automatic, English, Russian;
- timestamps: off, segment timestamps;
- configurable chunk and stride values controlled by profile, not arbitrary user text;
- deterministic defaults restored by Clear session.

### Output

- plain transcript text;
- timestamped segments when available;
- copy to clipboard;
- TXT export;
- SRT and WebVTT export when segment timing is valid;
- safe filename derived locally without exposing the source filename outside the browser;
- empty and partial-result states.

### Progress and cancellation

- preparation progress distinguishes manifest, tokenizer/config, model, runtime initialization, and warm-up;
- inference progress is approximate and must be labeled accordingly;
- cancel preparation;
- cancel transcription;
- hard cancellation may terminate and recreate the Worker;
- navigation and Clear session release all content resources.

## 5. Non-functional requirements

### Privacy

Audio, filenames, transcript text, segments, and user edits must not enter telemetry, logs, URLs, crash reports, host bridge messages, local persistent storage, or network requests.

### Responsiveness

React interactions, scrolling, cancellation, and progress UI remain responsive during preparation and inference. Heavy work is Worker-only.

### Accessibility

- keyboard-operable controls;
- semantic labels and status regions;
- progress announcements that do not spam screen readers;
- visible focus;
- no color-only state communication;
- transcript editor and export controls usable at 200% zoom.

### Compatibility

Supported browser versions are defined before implementation. Minimum release matrix should cover current Chromium on Windows, current Firefox, and current Safari where model/runtime support permits. Unsupported combinations receive a clear file-only or WASM-only fallback message.

### Reliability

- stable error taxonomy;
- safe retries;
- model corruption or partial cache detection;
- no infinite preparation loops;
- no duplicate concurrent pipeline initialization;
- deterministic cleanup after errors.

## 6. UX states

`idle -> input-selected -> normalizing -> ready -> preparing-model -> transcribing -> complete`

Additional states: `recording`, `cancelling`, `cancelled`, `recoverable-error`, `fatal-error`, `unsupported`.

Only valid transitions are allowed. Starting a new job while another runs requires cancellation or explicit replacement.

## 7. User-facing privacy copy

Required concepts:

- transcription runs in the browser;
- first use downloads model files;
- model files may be cached by the browser;
- browser storage may be cleared or evicted;
- microphone permission is requested only when recording starts;
- clearing the session removes in-memory audio and transcript state;
- no claim of guaranteed offline use.

## 8. Out of scope

- live word-by-word captions;
- diarization or speaker identity;
- cloud fallback;
- transcript account history;
- collaborative editing;
- automatic meeting joining;
- medium or large Whisper models;
- arbitrary model URLs;
- server-side upload or processing;
- audio enhancement, denoising, or source separation.

## 9. Acceptance criteria

Version 1 is accepted when file and microphone workflows use one validated audio contract, WASM works independently of WebGPU, cancellation reliably releases resources, output exports validate, content is absent from network/log/telemetry inspection, and the embedded production route passes browser, accessibility, security-header, memory, performance, and rollback checks.
