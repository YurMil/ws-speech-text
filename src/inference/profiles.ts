import type { ModelProfile } from './types';

/**
 * Hub delivery with pinned package versions.
 *
 * `revision` must stay an immutable commit SHA, never a branch name: the host
 * CSP allowlists the Hub origins, and rollback depends on the weights behind a
 * given release never changing under us.
 */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'whisper-tiny-multilingual-wasm',
    label: 'Whisper Tiny (multilingual)',
    modelId: 'onnx-community/whisper-tiny',
    revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
    multilingual: true,
    approximateDownloadBytes: 77_000_000,
    devices: ['wasm', 'webgpu'],
    dtypeByDevice: {
      wasm: 'q8',
      webgpu: 'fp16',
    },
    downloadBytesByDevice: {
      wasm: 41_000_000,
      webgpu: 77_000_000,
    },
    chunkLengthSeconds: 30,
    strideLengthSeconds: 5,
    maxDurationSeconds: 3 * 60 * 60,
  },
] as const;

export const DEFAULT_PROFILE_ID = MODEL_PROFILES[0].id;

export function getProfile(profileId: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((profile) => profile.id === profileId);
}

/** Decimal units, so the size shown matches how downloads are quoted. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) {
    return `${Math.round(bytes / 1000)} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}

/**
 * Robust User Agent detection to identify mobile/iOS platforms.
 */
export function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMobileDevice = /Mobi|Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  return isIOS || isAndroid || isMobileDevice;
}

