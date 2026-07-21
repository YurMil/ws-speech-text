import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { AUDIO_LIMITS, AudioPipelineError } from '../audio/limits';
import { transcribeMediaConveyor, type ConveyorProgress } from '../audio/conveyor';
import {
  guessMediaKind,
  probeMedia,
  shouldUseConveyor,
} from '../audio/mediaProbe';
import { startMicrophoneRecording, type RecorderHandle } from '../audio/microphone';
import { normalizeAudioBlob } from '../audio/normalize';
import {
  downloadTextFile,
  safeExportBasename,
  toSrt,
  toTxt,
  toWebVtt,
} from '../export/formats';
import { DEFAULT_PROFILE_ID, formatBytes, getProfile, MODEL_PROFILES } from '../inference/profiles';
import { inferenceClient } from '../inference/requestManager';
import type {
  LanguageOption,
  ProgressEvent,
  RuntimeDiagnostics,
  RuntimePreference,
  TimestampsOption,
  TranscriptResult,
} from '../inference/types';

type Phase =
  | 'idle'
  | 'input-selected'
  | 'normalizing'
  | 'ready'
  | 'recording'
  | 'preparing-model'
  | 'transcribing'
  | 'complete'
  | 'cancelling'
  | 'error';

type InlineSession = {
  mode: 'inline';
  samples: Float32Array;
  durationSeconds: number;
  warnings: string[];
  sourceLabel: string;
};

type ConveyorSession = {
  mode: 'conveyor';
  blob: Blob;
  mediaKind: 'audio' | 'video' | 'unknown';
  durationSeconds: number;
  warnings: string[];
  sourceLabel: string;
  byteLength: number;
  formatName?: string;
};

type MediaSession = InlineSession | ConveyorSession;

function progressLabel(
  progress: ProgressEvent | null,
  conveyor: ConveyorProgress | null,
): string {
  if (conveyor) {
    return conveyor.message;
  }
  if (!progress) return 'Working…';
  switch (progress.phase) {
    case 'download':
      if (progress.ratio != null) {
        return `Downloading model… ${Math.round(progress.ratio * 100)}%`;
      }
      return 'Downloading model…';
    case 'runtime-init':
      return 'Initializing runtime…';
    case 'model-init':
      return 'Preparing model…';
    case 'warmup':
      return 'Warming up…';
    case 'inference':
      return progress.approximate ? 'Transcribing… (approximate)' : 'Transcribing…';
    case 'finalize':
      return 'Finalizing…';
    default:
      return 'Working…';
  }
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [language, setLanguage] = useState<LanguageOption>('auto');
  const [timestamps, setTimestamps] = useState<TimestampsOption>('segment');
  const [runtimePreference, setRuntimePreference] = useState<RuntimePreference>('auto');
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE_ID);
  const [media, setMedia] = useState<MediaSession | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [conveyorProgress, setConveyorProgress] = useState<ConveyorProgress | null>(null);
  const [status, setStatus] = useState(
    'Select an audio/video file or record from the microphone.',
  );
  const [statusTone, setStatusTone] = useState<'neutral' | 'ok' | 'error'>('neutral');
  const [transcriptText, setTranscriptText] = useState('');
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<RecorderHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const profile = useMemo(() => getProfile(profileId), [profileId]);
  const busy =
    phase === 'normalizing' ||
    phase === 'preparing-model' ||
    phase === 'transcribing' ||
    phase === 'cancelling' ||
    phase === 'recording';

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      recorderRef.current?.cancel();
      inferenceClient.dispose();
    };
  }, []);

  async function ingestFile(file: File): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('normalizing');
    setStatus('Inspecting media (duration, audio track)…');
    setStatusTone('neutral');
    setResult(null);
    setTranscriptText('');
    setProgress(null);
    setConveyorProgress(null);

    const kind = guessMediaKind(file);

    try {
      const probe = await probeMedia(file, { signal: controller.signal });
      if (controller.signal.aborted) return;

      if (!probe.canDecodeAudio) {
        throw new AudioPipelineError(
          'AUDIO_DECODE_UNSUPPORTED',
          'decode',
          'This browser cannot decode the audio track via WebCodecs.',
        );
      }

      const useConveyor = shouldUseConveyor(probe, probe.kind);
      const warnings: string[] = [];
      if (useConveyor) {
        warnings.push(
          `Conveyor mode: ${AUDIO_LIMITS.windowSeconds}s windows, ${AUDIO_LIMITS.overlapSeconds}s overlap — model stays loaded.`,
        );
      }

      if (useConveyor) {
        setMedia({
          mode: 'conveyor',
          blob: file,
          mediaKind: probe.kind,
          durationSeconds: probe.durationSeconds,
          warnings,
          sourceLabel: probe.kind === 'video' ? 'Video file' : 'Media file',
          byteLength: probe.byteLength,
          formatName: probe.formatName,
        });
        setPhase('ready');
        setStatus(
          `Ready · ${probe.kind} · ${formatClock(probe.durationSeconds)} · ${formatBytes(probe.byteLength)} · windowed pipeline`,
        );
        setStatusTone('ok');
        return;
      }

      setStatus('Normalizing short clip to mono 16 kHz…');
      const normalized = await normalizeAudioBlob(file, {
        signal: controller.signal,
        maxDurationSeconds: AUDIO_LIMITS.inlineDecodeMaxSeconds,
      });
      if (controller.signal.aborted) return;

      setMedia({
        mode: 'inline',
        samples: normalized.samples,
        durationSeconds: normalized.durationSeconds,
        warnings: normalized.warnings,
        sourceLabel: kind === 'video' ? 'Video file' : 'Uploaded file',
      });
      setPhase('ready');
      setStatus(
        normalized.warnings[0] ??
          `Ready · ${normalized.durationSeconds.toFixed(1)}s · mono 16 kHz`,
      );
      setStatusTone(normalized.warnings.length ? 'neutral' : 'ok');
    } catch (error) {
      if (controller.signal.aborted) return;

      // Fallback for tiny audio-only files when container probe fails.
      if (
        kind !== 'video' &&
        file.size <= AUDIO_LIMITS.inlineDecodeMaxBytes
      ) {
        try {
          const normalized = await normalizeAudioBlob(file, {
            signal: controller.signal,
            maxDurationSeconds: AUDIO_LIMITS.inlineDecodeMaxSeconds,
          });
          if (controller.signal.aborted) return;
          setMedia({
            mode: 'inline',
            samples: normalized.samples,
            durationSeconds: normalized.durationSeconds,
            warnings: normalized.warnings,
            sourceLabel: 'Uploaded file',
          });
          setPhase('ready');
          setStatus(
            normalized.warnings[0] ??
              `Ready · ${normalized.durationSeconds.toFixed(1)}s · mono 16 kHz`,
          );
          setStatusTone(normalized.warnings.length ? 'neutral' : 'ok');
          return;
        } catch {
          // fall through
        }
      }

      const message =
        error instanceof AudioPipelineError
          ? error.message
          : 'Could not prepare the selected media.';
      setMedia(null);
      setPhase('error');
      setStatus(message);
      setStatusTone('error');
    }
  }

  async function ingestRecordingBlob(blob: Blob): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('normalizing');
    setStatus('Normalizing recording to mono 16 kHz…');
    setStatusTone('neutral');
    setResult(null);
    setTranscriptText('');
    setProgress(null);
    setConveyorProgress(null);

    try {
      const normalized = await normalizeAudioBlob(blob, { signal: controller.signal });
      if (controller.signal.aborted) return;

      setMedia({
        mode: 'inline',
        samples: normalized.samples,
        durationSeconds: normalized.durationSeconds,
        warnings: normalized.warnings,
        sourceLabel: 'Microphone recording',
      });
      setPhase('ready');
      setStatus(
        normalized.warnings[0] ??
          `Ready · ${normalized.durationSeconds.toFixed(1)}s · mono 16 kHz`,
      );
      setStatusTone(normalized.warnings.length ? 'neutral' : 'ok');
    } catch (error) {
      if (controller.signal.aborted) return;
      const message =
        error instanceof AudioPipelineError
          ? error.message
          : 'Could not prepare the recording.';
      setMedia(null);
      setPhase('error');
      setStatus(message);
      setStatusTone('error');
    }
  }

  async function onFileChosen(file: File | null): Promise<void> {
    if (!file) return;
    await ingestFile(file);
  }

  async function onDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      await onFileChosen(file);
    }
  }

  async function startRecording(): Promise<void> {
    if (busy) return;
    clearSession(false);
    setPhase('recording');
    setRecordingSeconds(0);
    setStatus('Recording… click Stop when finished.');
    setStatusTone('neutral');

    try {
      const handle = await startMicrophoneRecording((elapsed) => {
        setRecordingSeconds(elapsed);
      });
      recorderRef.current = handle;
    } catch {
      setPhase('error');
      setStatus('Microphone permission denied or unavailable. File upload still works.');
      setStatusTone('error');
    }
  }

  async function stopRecording(): Promise<void> {
    const handle = recorderRef.current;
    if (!handle) return;
    recorderRef.current = null;
    try {
      const blob = await handle.stop();
      await ingestRecordingBlob(blob);
    } catch {
      setPhase('error');
      setStatus('Recording failed.');
      setStatusTone('error');
    }
  }

  async function runTranscription(): Promise<void> {
    if (!media || !profile) return;

    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('preparing-model');
    setStatus(
      'Preparing model… first run downloads ~' + formatBytes(profile.approximateDownloadBytes),
    );
    setStatusTone('neutral');
    setProgress(null);
    setConveyorProgress(null);

    try {
      const prepared = await inferenceClient.prepare(profileId, runtimePreference, setProgress);
      setDiagnostics(prepared.diagnostics);
      if (prepared.diagnostics.fallbackReasonCode) {
        setStatus(`WebGPU unavailable — using WASM (${prepared.diagnostics.fallbackReasonCode}).`);
      }

      setPhase('transcribing');
      setStatus(
        media.mode === 'conveyor'
          ? 'Conveyor transcription started…'
          : 'Transcribing…',
      );

      let next: TranscriptResult;

      if (media.mode === 'conveyor') {
        next = await transcribeMediaConveyor({
          blob: media.blob,
          profileId,
          runtimePreference,
          language,
          timestamps,
          client: inferenceClient,
          signal: controller.signal,
          onModelProgress: setProgress,
          onChunkProgress: (chunk) => {
            setConveyorProgress(chunk);
            setProgress({
              phase: 'inference',
              status: 'running',
              ratio: chunk.ratio,
              approximate: true,
            });
          },
          onPartialResult: (partial) => {
            setResult(partial);
            setTranscriptText(partial.text);
          },
        });
      } else {
        const samples = media.samples.slice();
        next = await inferenceClient.transcribe({
          profileId,
          runtimePreference,
          audio: samples,
          language,
          timestamps,
          onProgress: setProgress,
        });
      }

      setResult(next);
      setTranscriptText(next.text);
      setPhase('complete');
      setProgress(null);
      setConveyorProgress(null);
      const warning = next.warnings[0];
      setStatus(
        warning ??
          (media.mode === 'conveyor'
            ? 'Transcription complete via windowed pipeline. Media stayed on-device.'
            : 'Transcription complete. Audio and text stayed in this browser session.'),
      );
      setStatusTone(warning ? 'neutral' : 'ok');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'CANCELLED' || (error instanceof AudioPipelineError && error.code === 'CANCELLED')) {
        setPhase(media ? 'ready' : 'idle');
        setStatus('Cancelled.');
        setStatusTone('neutral');
        setProgress(null);
        setConveyorProgress(null);
        return;
      }
      setPhase('error');
      setStatus(
        error instanceof AudioPipelineError
          ? error.message
          : code
            ? `Transcription failed (${code}).`
            : 'Transcription failed.',
      );
      setStatusTone('error');
      setProgress(null);
      setConveyorProgress(null);
    }
  }

  async function cancelWork(): Promise<void> {
    setPhase('cancelling');
    setStatus('Cancelling…');
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    await inferenceClient.cancel();
    setPhase(media ? 'ready' : 'idle');
    setProgress(null);
    setConveyorProgress(null);
    setStatus('Cancelled. Session media still available until Clear.');
    setStatusTone('neutral');
  }

  function clearSession(resetStatus = true): void {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    inferenceClient.hardReset();
    setMedia(null);
    setResult(null);
    setTranscriptText('');
    setProgress(null);
    setConveyorProgress(null);
    setDiagnostics(null);
    setRecordingSeconds(0);
    setPhase('idle');
    if (resetStatus) {
      setStatus('Session cleared. Nothing was saved.');
      setStatusTone('neutral');
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function exportTxt(): void {
    const payload = toTxt({
      text: transcriptText,
      segments: result?.segments ?? [],
      durationSeconds: result?.durationSeconds ?? media?.durationSeconds ?? 0,
      warnings: result?.warnings ?? [],
    });
    downloadTextFile(`${safeExportBasename()}.txt`, payload, 'text/plain;charset=utf-8');
  }

  function exportSrt(): void {
    if (!result?.segments.length) return;
    downloadTextFile(`${safeExportBasename()}.srt`, toSrt(result.segments), 'application/x-subrip');
  }

  function exportVtt(): void {
    if (!result?.segments.length) return;
    downloadTextFile(`${safeExportBasename()}.vtt`, toWebVtt(result.segments), 'text/vtt');
  }

  async function copyTranscript(): Promise<void> {
    await navigator.clipboard.writeText(transcriptText);
    setStatus('Copied to clipboard.');
    setStatusTone('ok');
  }

  const progressRatio = conveyorProgress?.ratio ?? progress?.ratio;

  return (
    <main className="shell">
      <header className="brand">
        <h1>Whisper Transcriber</h1>
        <p>
          Private speech-to-text in your browser. Audio and video are processed in a windowed
          conveyor (mono 16 kHz chunks) so large files do not load full PCM into memory. The model
          stays resident across windows.
        </p>
      </header>

      <section className="panel" aria-labelledby="input-heading">
        <h2 id="input-heading">Input</h2>

        <div
          className={`dropzone${dragActive ? ' active' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
        >
          Drop an audio or video file here, or choose one below.
          <div className="field" style={{ marginTop: '0.85rem' }}>
            <label htmlFor="audio-file">Audio / video file</label>
            <input
              id="audio-file"
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/*,.wav,.mp3,.m4a,.ogg,.webm,.flac,.mp4,.m4v,.mov,.mkv,.avi,.mpeg,.mpg,.ogv"
              disabled={busy}
              onChange={(event) => void onFileChosen(event.target.files?.[0] ?? null)}
            />
          </div>
        </div>

        <div className="actions">
          {phase === 'recording' ? (
            <button type="button" className="btn danger" onClick={() => void stopRecording()}>
              Stop ({formatClock(recordingSeconds)})
            </button>
          ) : (
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => void startRecording()}
            >
              Record microphone
            </button>
          )}
          <button
            type="button"
            className="btn secondary"
            disabled={phase === 'idle' && !media && !result}
            onClick={() => clearSession()}
          >
            Clear session
          </button>
        </div>
      </section>

      <section className="panel" aria-labelledby="settings-heading">
        <h2 id="settings-heading">Settings</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="profile">Model</label>
            <select
              id="profile"
              value={profileId}
              disabled={busy}
              onChange={(event) => setProfileId(event.target.value)}
            >
              {MODEL_PROFILES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} (~{formatBytes(item.approximateDownloadBytes)})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="language">Language</label>
            <select
              id="language"
              value={language}
              disabled={busy}
              onChange={(event) => setLanguage(event.target.value as LanguageOption)}
            >
              <option value="auto">Automatic</option>
              <option value="en">English</option>
              <option value="ru">Russian</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="timestamps">Timestamps</label>
            <select
              id="timestamps"
              value={timestamps}
              disabled={busy}
              onChange={(event) => setTimestamps(event.target.value as TimestampsOption)}
            >
              <option value="segment">Segment</option>
              <option value="none">Off</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="runtime">Runtime</label>
            <select
              id="runtime"
              value={runtimePreference}
              disabled={busy}
              onChange={(event) => setRuntimePreference(event.target.value as RuntimePreference)}
            >
              <option value="auto">Auto (WebGPU → WASM)</option>
              <option value="wasm">WASM only</option>
              <option value="webgpu">WebGPU preferred</option>
            </select>
          </div>
        </div>

        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={!media || busy}
            onClick={() => void runTranscription()}
          >
            Transcribe
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={!busy || phase === 'recording'}
            onClick={() => void cancelWork()}
          >
            Cancel
          </button>
        </div>

        <div className="status" data-tone={statusTone} role="status" aria-live="polite">
          {busy && phase !== 'recording' ? progressLabel(progress, conveyorProgress) : status}
        </div>
        {progressRatio != null && (
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${Math.round(Math.min(1, Math.max(0, progressRatio)) * 100)}%` }} />
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="result-heading">
        <h2 id="result-heading">Transcript</h2>
        <label className="field" htmlFor="transcript">
          Editable result
          <textarea
            id="transcript"
            className="transcript"
            value={transcriptText}
            onChange={(event) => setTranscriptText(event.target.value)}
            placeholder="Transcript appears here after inference. Large media updates window by window."
          />
        </label>

        <div className="actions">
          <button
            type="button"
            className="btn secondary"
            disabled={!transcriptText}
            onClick={() => void copyTranscript()}
          >
            Copy
          </button>
          <button type="button" className="btn secondary" disabled={!transcriptText} onClick={exportTxt}>
            Export TXT
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={!result?.segments.length}
            onClick={exportSrt}
          >
            Export SRT
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={!result?.segments.length}
            onClick={exportVtt}
          >
            Export WebVTT
          </button>
        </div>

        {!!result?.segments.length && (
          <ul className="segments" aria-label="Timestamped segments">
            {result.segments.map((segment, index) => (
              <li key={`${segment.startSeconds}-${index}`}>
                <time>
                  {formatClock(segment.startSeconds)}–{formatClock(segment.endSeconds)}
                </time>
                <span>{segment.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="diagnostics-heading">
        <h2 id="diagnostics-heading">Diagnostics</h2>
        <div className="meta">
          <span>phase: {phase}</span>
          <span>mode: {media?.mode ?? '—'}</span>
          <span>profile: {profile?.id ?? '—'}</span>
          <span>source: {media?.sourceLabel ?? '—'}</span>
          {media?.mode === 'conveyor' && (
            <>
              <span>media: {media.mediaKind}</span>
              <span>bytes: {formatBytes(media.byteLength)}</span>
              <span>format: {media.formatName ?? '—'}</span>
            </>
          )}
          <span>
            duration: {media ? formatClock(media.durationSeconds) : '—'}
          </span>
          <span>
            window: {AUDIO_LIMITS.windowSeconds}s / overlap {AUDIO_LIMITS.overlapSeconds}s
          </span>
          <span>
            chunk:{' '}
            {conveyorProgress
              ? `${conveyorProgress.chunkIndex + 1}/${conveyorProgress.chunkTotal}`
              : '—'}
          </span>
          <span>runtime: {diagnostics?.effectiveRuntime ?? '—'}</span>
          <span>requested: {diagnostics?.requestedRuntime ?? runtimePreference}</span>
          <span>prep: {diagnostics?.preparationMs != null ? `${diagnostics.preparationMs} ms` : '—'}</span>
          <span>build: {__APP_VERSION__} · {__BUILD_ID__}</span>
        </div>
      </section>
    </main>
  );
}
