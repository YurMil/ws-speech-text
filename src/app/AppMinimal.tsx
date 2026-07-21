import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { AUDIO_LIMITS, AudioPipelineError, getInlineDecodeMaxSeconds } from '../audio/limits';
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
import { DEFAULT_PROFILE_ID, formatBytes, getProfile, MODEL_PROFILES, isMobileUA } from '../inference/profiles';
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
  if (!progress) return 'Processing…';
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
      return 'Processing…';
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

export function AppMinimal() {
  const isMobile = useMemo(() => isMobileUA(), []);
  
  const [phase, setPhase] = useState<Phase>('idle');
  const [language, setLanguage] = useState<LanguageOption>('auto');
  const [timestamps, setTimestamps] = useState<TimestampsOption>('segment');
  
  // Default to WASM on mobile, otherwise AUTO
  const [runtimePreference, setRuntimePreference] = useState<RuntimePreference>(
    isMobile ? 'wasm' : 'auto'
  );
  
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE_ID);
  const [media, setMedia] = useState<MediaSession | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [conveyorProgress, setConveyorProgress] = useState<ConveyorProgress | null>(null);
  const [status, setStatus] = useState('Select an audio/video file or record from microphone.');
  const [statusTone, setStatusTone] = useState<'neutral' | 'ok' | 'error'>('neutral');
  const [transcriptText, setTranscriptText] = useState('');
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [webGpuSupport, setWebGpuSupport] = useState<{
    supported: boolean;
    maxStorageBufferBindingSize?: number;
    reason?: string;
  }>({ supported: false });
  const [wakeLockActive, setWakeLockActive] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<RecorderHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wakeLockRef = useRef<any>(null);

  const profile = useMemo(() => getProfile(profileId), [profileId]);
  const busy =
    phase === 'normalizing' ||
    phase === 'preparing-model' ||
    phase === 'transcribing' ||
    phase === 'cancelling' ||
    phase === 'recording';

  // Check WebGPU hardware capabilities on mount
  useEffect(() => {
    async function checkWebGpu() {
      if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
        setWebGpuSupport({ supported: false, reason: 'navigator.gpu not in browser' });
        return;
      }
      try {
        const adapter = await (navigator as any).gpu.requestAdapter();
        if (!adapter) {
          setWebGpuSupport({ supported: false, reason: 'requestAdapter returned null' });
          return;
        }
        const maxStorageBufferBindingSize = adapter.limits?.maxStorageBufferBindingSize ?? 0;
        setWebGpuSupport({
          supported: true,
          maxStorageBufferBindingSize,
        });
      } catch (err) {
        setWebGpuSupport({
          supported: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void checkWebGpu();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      recorderRef.current?.cancel();
      inferenceClient.dispose();
      releaseWakeLock();
    };
  }, []);

  // Request/Release Wake Lock
  async function acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        setWakeLockActive(true);
      } catch (err) {
        console.warn('Wake Lock request failed:', err);
      }
    }
  }

  function releaseWakeLock() {
    if (wakeLockRef.current) {
      wakeLockRef.current.release()
        .then(() => {
          wakeLockRef.current = null;
          setWakeLockActive(false);
        })
        .catch((err: any) => {
          console.error('Error releasing Wake Lock:', err);
        });
    }
  }

  // Calculate dynamic download size based on target runtime and device configuration
  const estimatedDownloadSize = useMemo(() => {
    if (!profile) return 0;
    let targetDevice: 'wasm' | 'webgpu' = 'wasm';
    if (runtimePreference === 'webgpu') {
      targetDevice = 'webgpu';
    } else if (runtimePreference === 'auto') {
      const gpuOk = webGpuSupport.supported && (webGpuSupport.maxStorageBufferBindingSize ?? 0) >= 128 * 1024 * 1024;
      targetDevice = (isMobile || !gpuOk) ? 'wasm' : 'webgpu';
    }
    return profile.downloadBytesByDevice[targetDevice];
  }, [profile, runtimePreference, webGpuSupport, isMobile]);

  const targetDtype = useMemo(() => {
    if (!profile) return '';
    let targetDevice: 'wasm' | 'webgpu' = 'wasm';
    if (runtimePreference === 'webgpu') {
      targetDevice = 'webgpu';
    } else if (runtimePreference === 'auto') {
      const gpuOk = webGpuSupport.supported && (webGpuSupport.maxStorageBufferBindingSize ?? 0) >= 128 * 1024 * 1024;
      targetDevice = (isMobile || !gpuOk) ? 'wasm' : 'webgpu';
    }
    return profile.dtypeByDevice[targetDevice];
  }, [profile, runtimePreference, webGpuSupport, isMobile]);

  async function ingestFile(file: File): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('normalizing');
    setStatus('Inspecting media track structure…');
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
          'WebCodecs cannot decode the audio track in this browser.',
        );
      }

      const useConveyor = shouldUseConveyor(probe, probe.kind);
      const warnings: string[] = [];
      if (useConveyor) {
        const windowSize = isMobile ? 15 : AUDIO_LIMITS.windowSeconds;
        const overlapSize = isMobile ? 3 : AUDIO_LIMITS.overlapSeconds;
        warnings.push(
          `Conveyor: ${windowSize}s windows, ${overlapSize}s overlap. Stays in-browser.`,
        );
      }

      if (useConveyor) {
        setMedia({
          mode: 'conveyor',
          blob: file,
          mediaKind: probe.kind,
          durationSeconds: probe.durationSeconds,
          warnings,
          sourceLabel: probe.kind === 'video' ? 'Video track' : 'Audio track',
          byteLength: probe.byteLength,
          formatName: probe.formatName,
        });
        setPhase('ready');
        setStatus(
          `Ready · ${probe.kind} · ${formatClock(probe.durationSeconds)} · ${formatBytes(probe.byteLength)} · windowed`,
        );
        setStatusTone('ok');
        return;
      }

      setStatus('Normalizing short clip to mono 16 kHz PCM…');
      const maxSeconds = getInlineDecodeMaxSeconds();
      const normalized = await normalizeAudioBlob(file, {
        signal: controller.signal,
        maxDurationSeconds: maxSeconds,
      });
      if (controller.signal.aborted) return;

      setMedia({
        mode: 'inline',
        samples: normalized.samples,
        durationSeconds: normalized.durationSeconds,
        warnings: normalized.warnings,
        sourceLabel: kind === 'video' ? 'Video clip' : 'Audio clip',
      });
      setPhase('ready');
      setStatus(
        normalized.warnings[0] ??
          `Ready · ${normalized.durationSeconds.toFixed(1)}s · mono 16 kHz`,
      );
      setStatusTone(normalized.warnings.length ? 'neutral' : 'ok');
    } catch (error) {
      if (controller.signal.aborted) return;

      if (kind !== 'video' && file.size <= AUDIO_LIMITS.inlineDecodeMaxBytes) {
        try {
          const maxSeconds = getInlineDecodeMaxSeconds();
          const normalized = await normalizeAudioBlob(file, {
            signal: controller.signal,
            maxDurationSeconds: maxSeconds,
          });
          if (controller.signal.aborted) return;
          setMedia({
            mode: 'inline',
            samples: normalized.samples,
            durationSeconds: normalized.durationSeconds,
            warnings: normalized.warnings,
            sourceLabel: 'Raw file',
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
          : 'Could not decode the selected file.';
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
    setStatus('Normalizing mic recording to mono 16 kHz…');
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
        sourceLabel: 'Voice recording',
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
          : 'Could not prepare recording.';
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
    setStatus('Recording active… Click Stop to process.');
    setStatusTone('neutral');

    try {
      const handle = await startMicrophoneRecording((elapsed) => {
        setRecordingSeconds(elapsed);
      });
      recorderRef.current = handle;
    } catch {
      setPhase('error');
      setStatus('Microphone permission blocked or unavailable.');
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
      setStatus('Recording stop failed.');
      setStatusTone('error');
    }
  }

  async function runTranscription(): Promise<void> {
    if (!media || !profile) return;

    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('preparing-model');
    setStatus(
      `Downloading/Loading model weights (~${formatBytes(estimatedDownloadSize)})…`
    );
    setStatusTone('neutral');
    setProgress(null);
    setConveyorProgress(null);

    try {
      await acquireWakeLock();

      const prepared = await inferenceClient.prepare(profileId, runtimePreference, setProgress);
      setDiagnostics(prepared.diagnostics);
      
      if (prepared.diagnostics.fallbackReasonCode) {
        setStatus(`GPU unavailable: using WASM (${prepared.diagnostics.fallbackReasonCode}).`);
      }

      setPhase('transcribing');
      setStatus(
        media.mode === 'conveyor'
          ? 'Conveyor window loop started…'
          : 'Running Whisper inference…',
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
            ? 'Complete via windowed conveyor. Local execution.'
            : 'Complete. Local browser session transcription.'),
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
            : 'Transcription execution error.',
      );
      setStatusTone('error');
      setProgress(null);
      setConveyorProgress(null);
    } finally {
      releaseWakeLock();
    }
  }

  async function cancelWork(): Promise<void> {
    setPhase('cancelling');
    setStatus('Cancelling engine task…');
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    await inferenceClient.cancel();
    setPhase(media ? 'ready' : 'idle');
    setProgress(null);
    setConveyorProgress(null);
    setStatus('Cancelled. Session cached.');
    setStatusTone('neutral');
    releaseWakeLock();
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
    releaseWakeLock();
    if (resetStatus) {
      setStatus('Session cleared.');
      setStatusTone('neutral');
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function switchToClassic(): void {
    localStorage.setItem('ui-mode', 'classic');
    window.location.reload();
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
    setStatus('Text copied to clipboard.');
    setStatusTone('ok');
  }

  const progressRatio = conveyorProgress?.ratio ?? progress?.ratio;

  // WebGPU support limits warnings
  const webGpuLimitLow = webGpuSupport.supported && (webGpuSupport.maxStorageBufferBindingSize ?? 0) < 128 * 1024 * 1024;
  const webGpuDisplayLimit = webGpuSupport.maxStorageBufferBindingSize 
    ? `${Math.round(webGpuSupport.maxStorageBufferBindingSize / 1024 / 1024)} MB` 
    : 'None';

  return (
    <div className="desktop-viewport">
      <div className="window-frame">
        {/* Title bar simulating a native desktop app */}
        <header className="window-titlebar">
          <div className="window-controls">
            <span className="control-dot red" title="Close" />
            <span className="control-dot yellow" title="Minimize" />
            <span className="control-dot green" title="Maximize" />
          </div>
          <div className="window-title">Whisper Transcriber</div>
          <button className="window-toggle-btn" onClick={switchToClassic}>
            Classic UI
          </button>
        </header>

        {/* Content body */}
        <main className="window-content">
          
          {/* Diagnostic & Environment Warnings */}
          <div className="system-notices">
            {isMobile && (
              <div className="notice-banner warning">
                <strong>Background Warning:</strong> iOS suspends background workers and tabs. 
                Keep this screen active and turned on during transcription.
              </div>
            )}
            
            {runtimePreference === 'webgpu' && webGpuLimitLow && (
              <div className="notice-banner danger">
                <strong>Low Buffer Binding Limit:</strong> Your GPU reports a binding limit of {webGpuDisplayLimit} (min required 128 MB). 
                WebGPU will likely crash; consider selecting WASM runtime.
              </div>
            )}
            
            <div className="badge-row">
              <span className={`status-badge ${wakeLockActive ? 'green' : ''}`}>
                Wake Lock: {wakeLockActive ? 'Active (Screen ON)' : 'Inactive'}
              </span>
              
              <span className={`status-badge ${webGpuSupport.supported ? (webGpuLimitLow ? 'highlight' : 'green') : ''}`}>
                GPU Buffer binding limit: {webGpuDisplayLimit}
              </span>
              
              <span className="status-badge highlight">
                Download estimate: ~{formatBytes(estimatedDownloadSize)} ({targetDtype})
              </span>
            </div>
          </div>

          {/* Input Panel */}
          <section className="input-area">
            {!media && phase !== 'recording' ? (
              <div
                className={`md-dropzone${dragActive ? ' active' : ''}`}
                onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragOver={(e) => e.preventDefault()}
                onDragLeave={() => setDragActive(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="dropzone-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <div className="dropzone-label">Drag & drop files here</div>
                <div className="dropzone-sublabel">Supports wav, mp3, mp4, mov, webm, m4a, and others</div>
                
                <div className="file-input-wrapper">
                  <button className="file-btn" type="button">Select File</button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*,video/*,.wav,.mp3,.m4a,.ogg,.webm,.flac,.mp4,.m4v,.mov,.mkv,.avi,.mpeg,.mpg,.ogv"
                    disabled={busy}
                    onChange={(e) => void onFileChosen(e.target.files?.[0] ?? null)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              </div>
            ) : (
              <div className="session-info-card">
                <div>
                  <span className="session-info-text">
                    {media ? media.sourceLabel : 'Recording session'}
                  </span>
                  {media && (
                    <span className="session-info-meta">
                      {' · '}{formatClock(media.durationSeconds)}
                      {media.mode === 'conveyor' && ' · conveyor pipeline'}
                      {media.mode === 'inline' && ' · fully buffered'}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn-pill danger"
                  disabled={busy}
                  onClick={() => clearSession()}
                >
                  Clear File
                </button>
              </div>
            )}

            <div className="actions-layout">
              {phase === 'recording' ? (
                <button type="button" className="btn-pill danger" onClick={() => void stopRecording()}>
                  Stop Recording ({formatClock(recordingSeconds)})
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-pill primary"
                  disabled={busy || !!media}
                  onClick={() => void startRecording()}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                    <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
                    <line x1="12" y1="19" x2="12" y2="22"/>
                  </svg>
                  Record Audio
                </button>
              )}

              {media && !busy && (
                <button
                  type="button"
                  className="btn-pill primary"
                  onClick={() => void runTranscription()}
                >
                  Start Transcription
                </button>
              )}

              {busy && phase !== 'recording' && (
                <button
                  type="button"
                  className="btn-pill danger"
                  onClick={() => void cancelWork()}
                >
                  Cancel
                </button>
              )}
            </div>
          </section>

          {/* Settings Section */}
          <section className="settings-section">
            <div className="settings-grid">
              <div className="md-field">
                <label htmlFor="profile">Model</label>
                <select
                  id="profile"
                  className="md-select"
                  value={profileId}
                  disabled={busy}
                  onChange={(e) => setProfileId(e.target.value)}
                >
                  {MODEL_PROFILES.map((item) => {
                    const dev = runtimePreference === 'webgpu' ? 'webgpu' : (runtimePreference === 'wasm' ? 'wasm' : (isMobile ? 'wasm' : 'webgpu'));
                    const size = item.downloadBytesByDevice[dev];
                    return (
                      <option key={item.id} value={item.id}>
                        {item.label} (~{formatBytes(size)})
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="md-field">
                <label htmlFor="language">Language</label>
                <select
                  id="language"
                  className="md-select"
                  value={language}
                  disabled={busy}
                  onChange={(e) => setLanguage(e.target.value as LanguageOption)}
                >
                  <option value="auto">Automatic Detection</option>
                  <option value="en">English Only</option>
                  <option value="ru">Russian Only</option>
                </select>
              </div>

              <div className="md-field">
                <label htmlFor="timestamps">Timestamps</label>
                <select
                  id="timestamps"
                  className="md-select"
                  value={timestamps}
                  disabled={busy}
                  onChange={(e) => setTimestamps(e.target.value as TimestampsOption)}
                >
                  <option value="segment">Show Timestamps</option>
                  <option value="none">Text Only</option>
                </select>
              </div>

              <div className="md-field">
                <label htmlFor="runtime">Engine Runtime</label>
                <select
                  id="runtime"
                  className="md-select"
                  value={runtimePreference}
                  disabled={busy}
                  onChange={(e) => setRuntimePreference(e.target.value as RuntimePreference)}
                >
                  <option value="auto">Auto (GPU/WASM)</option>
                  <option value="wasm">WASM Only (Safe/Mobile)</option>
                  <option value="webgpu">WebGPU Preferred</option>
                </select>
              </div>
            </div>
          </section>

          {/* Status Message */}
          <div className={`status-text ${statusTone !== 'neutral' ? statusTone : ''}`}>
            {phase === 'recording' && (
              <span className="control-dot red" style={{ animation: 'pulse 1.2s infinite' }} />
            )}
            {status}
          </div>

          {/* Progress Indicator */}
          {progressRatio != null && (
            <div className="progress-container">
              <div className="progress-label-row">
                <span>{progressLabel(progress, conveyorProgress)}</span>
                <span>{Math.round(progressRatio * 100)}%</span>
              </div>
              <div className={`progress-track ${busy ? 'active' : ''}`}>
                <div
                  className="progress-fill"
                  style={{ width: `${progressRatio * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Outputs */}
          {transcriptText && (
            <section className="output-card">
              <div className="output-title-row">
                <h3>Transcribed Output</h3>
                <div className="actions-layout" style={{ margin: 0 }}>
                  <button type="button" className="btn-pill secondary" onClick={() => void copyTranscript()}>
                    Copy
                  </button>
                  <button type="button" className="btn-pill tonal" onClick={exportTxt}>
                    TXT
                  </button>
                  {result && result.segments.length > 0 && (
                    <>
                      <button type="button" className="btn-pill tonal" onClick={exportSrt}>
                        SRT
                      </button>
                      <button type="button" className="btn-pill tonal" onClick={exportVtt}>
                        VTT
                      </button>
                    </>
                  )}
                </div>
              </div>

              {timestamps === 'segment' && result && result.segments.length > 0 ? (
                <ul className="segments-list">
                  {result.segments.map((seg, idx) => (
                    <li key={idx} className="segment-item">
                      <span className="segment-time">
                        [{formatClock(seg.startSeconds)} → {formatClock(seg.endSeconds)}]
                      </span>
                      <span className="segment-text">{seg.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <textarea
                  className="output-textarea"
                  readOnly
                  value={transcriptText}
                />
              )}
            </section>
          )}

          {/* Diagnostics Section */}
          {diagnostics && (
            <section className="diagnostics-panel">
              <div className="diagnostics-title">Engine Diagnostics</div>
              <div className="diagnostics-grid">
                <div className="diagnostic-item">
                  <span>Runtime:</span> {diagnostics.effectiveRuntime}
                </div>
                <div className="diagnostic-item">
                  <span>Model ID:</span> {diagnostics.modelProfileId}
                </div>
                <div className="diagnostic-item">
                  <span>Preparation:</span> {diagnostics.preparationMs ? `${(diagnostics.preparationMs / 1000).toFixed(2)}s` : 'N/A'}
                </div>
                <div className="diagnostic-item">
                  <span>Inference:</span> {diagnostics.inferenceMs ? `${(diagnostics.inferenceMs / 1000).toFixed(2)}s` : 'N/A'}
                </div>
                {diagnostics.fallbackReasonCode && (
                  <div className="diagnostic-item" style={{ color: 'var(--md-error)' }}>
                    <span>Fallback:</span> {diagnostics.fallbackReasonCode}
                  </div>
                )}
              </div>
            </section>
          )}

        </main>
      </div>

      <style>{`
        @keyframes pulse {
          0% { opacity: 0.3; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.1); }
          100% { opacity: 0.3; transform: scale(0.9); }
        }
      `}</style>
    </div>
  );
}
