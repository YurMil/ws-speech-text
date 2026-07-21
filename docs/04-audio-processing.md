# Audio Processing Specification

## 1. Canonical inference input

Every inference request receives:

```ts
type NormalizedAudio = {
  samples: Float32Array;
  sampleRate: 16000;
  channels: 1;
  durationSeconds: number;
};
```

Samples must be finite and normally clamped to `[-1, 1]`. Empty, all-invalid, or out-of-limit buffers are rejected before Worker transfer.

## 2. Shared pipeline

Uploaded files and microphone recordings converge on one path:

```text
Blob/File -> decode -> inspect -> downmix -> resample -> validate -> transfer
```

No input path may bypass validation or send raw 44.1/48 kHz channel data directly to Whisper.

## 3. File handling

1. Validate configured byte limit before decoding.
2. Treat MIME and extension as hints, not proof.
3. Decode in a short-lived `AudioContext` or approved decoder.
4. Read actual sample rate, channel count, frame count, and duration.
5. Reject excessive decoded duration before allocating additional large buffers.
6. Always close the decoding context in `finally`.

Browser codec support differs. Display `AUDIO_DECODE_UNSUPPORTED` rather than claiming universal support for every listed extension.

## 4. Channel downmix

For mono, copy the channel. For stereo, use an average with clipping protection. For more channels, use a documented deterministic policy.

```ts
mono[i] = sum(channel[c][i] * weight[c]) / weightSum;
```

Do not silently select only channel 0. Tests must cover opposing-phase stereo, unequal channels, silence, clipping, and multichannel inputs.

## 5. Resampling

Target exactly 16,000 Hz. Do not rely solely on `new AudioContext({sampleRate: 16000})`; browsers may ignore or adapt requested rates.

Recommended policy:

- inspect the decoded rate;
- if already 16 kHz, reuse/copy after downmix;
- otherwise run a deterministic resampler;
- verify the resulting sample count against expected duration;
- include anti-alias filtering for downsampling.

An `OfflineAudioContext` may be used only after cross-browser tests. A dedicated tested resampler provides more reproducible behavior.

## 6. Microphone capture

Version 1 is record-then-transcribe, not streaming.

- request permission only after a click;
- use constraints conservatively;
- show active recording state and elapsed time;
- enforce a maximum recording duration;
- stop every track after stop, error, clear, or navigation;
- decode the resulting Blob through the same file pipeline;
- do not retain device labels or IDs.

The application remains usable for file transcription when permission is denied.

## 7. Limits

Limits are configuration values and must be selected through benchmarking:

- maximum source bytes;
- maximum decoded duration;
- maximum recording duration;
- maximum normalized sample count;
- warning threshold for memory-constrained devices.

Duration is more important than compressed file size because decoded PCM and inference memory dominate.

## 8. Validation

Before transfer:

- `samples instanceof Float32Array`;
- length greater than zero;
- length within profile maximum;
- all values finite;
- sample rate exactly 16000;
- duration consistent within tolerance;
- optional peak and RMS checks for diagnostics only.

Do not reject quiet audio solely because RMS is low; show a warning.

## 9. Memory model

Approximate PCM memory is `samples.length * 4` bytes, plus source buffers, decoder buffers, Worker copies/transfers, model tensors, and result data.

Use transferable buffers to avoid copying. Release source ArrayBuffers, decoded AudioBuffers, Blob URLs, and temporary channel arrays as soon as the normalized transfer is complete.

## 10. Cancellation and cleanup

Normalization uses an `AbortSignal` where possible. On cancellation:

- stop recording tracks;
- abort reads/decoding adapters when supported;
- close AudioContext;
- revoke object URLs;
- clear temporary arrays;
- do not start Worker inference.

## 11. Tests

Required fixtures:

- mono WAV 16 kHz;
- stereo WAV 44.1 kHz;
- stereo MP3 48 kHz;
- quiet speech;
- clipped speech;
- silence;
- corrupt input;
- unsupported codec;
- long-duration rejection;
- odd sample rates;
- NaN/Infinity injection at validator level;
- microphone Blob from each supported browser family.

Golden tests validate duration, channel mix, sample count, finite range, and deterministic output tolerance. They do not require transcript accuracy for every audio-unit test.
