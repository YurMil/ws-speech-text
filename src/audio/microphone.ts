import { AUDIO_LIMITS } from './limits';

export type RecorderHandle = {
  stop: () => Promise<Blob>;
  cancel: () => void;
  getElapsedSeconds: () => number;
};

export async function startMicrophoneRecording(
  onTick?: (elapsedSeconds: number) => void,
): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    },
  });

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : undefined;

  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  const startedAt = performance.now();
  let tickTimer: number | undefined;
  let maxTimer: number | undefined;
  let settle: ((blob: Blob) => void) | undefined;
  let rejectSettle: ((error: Error) => void) | undefined;
  let stopped = false;

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  recorder.onerror = () => {
    rejectSettle?.(new Error('Microphone recording failed.'));
  };

  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    if (tickTimer !== undefined) window.clearInterval(tickTimer);
    if (maxTimer !== undefined) window.clearTimeout(maxTimer);
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    settle?.(blob);
  };

  const stopTracks = () => {
    stream.getTracks().forEach((track) => track.stop());
  };

  tickTimer = window.setInterval(() => {
    onTick?.((performance.now() - startedAt) / 1000);
  }, 250);

  maxTimer = window.setTimeout(() => {
    if (!stopped && recorder.state === 'recording') {
      stopped = true;
      recorder.stop();
    }
  }, AUDIO_LIMITS.maxRecordingSeconds * 1000);

  recorder.start(250);

  return {
    getElapsedSeconds: () => (performance.now() - startedAt) / 1000,
    cancel: () => {
      stopped = true;
      if (recorder.state !== 'inactive') {
        recorder.onstop = () => stopTracks();
        recorder.stop();
      } else {
        stopTracks();
      }
      if (tickTimer !== undefined) window.clearInterval(tickTimer);
      if (maxTimer !== undefined) window.clearTimeout(maxTimer);
      rejectSettle?.(new Error('Recording cancelled.'));
    },
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        if (stopped) {
          reject(new Error('Recording already stopped.'));
          return;
        }
        stopped = true;
        settle = resolve;
        rejectSettle = reject;
        if (recorder.state === 'recording') {
          recorder.stop();
        } else {
          stopTracks();
          reject(new Error('Recorder was not active.'));
        }
      }),
  };
}
