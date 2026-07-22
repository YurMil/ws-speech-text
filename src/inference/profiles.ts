import type { ModelProfile } from './types';

/**
 * Hub delivery with pinned package versions.
 *
 * `revision` must stay an immutable commit SHA, never a branch name: the host
 * CSP allowlists the Hub origins, and rollback depends on the weights behind a
 * given release never changing under us.
 */
/*
 * Sizes below are encoder + merged decoder, measured from the pinned revision.
 * Note the inversion on base/small: q4 is *larger* than q8 there, because q4
 * only quantizes part of the graph and leaves the rest wide. So each profile
 * picks the dtype that is actually smallest and good enough, not the one whose
 * name sounds smallest.
 */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'whisper-tiny-multilingual-wasm',
    label: 'Tiny',
    modelId: 'onnx-community/whisper-tiny',
    revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
    multilingual: true,
    devices: ['wasm', 'webgpu'],
    dtypeByDevice: { wasm: 'q8', webgpu: 'fp16' },
    downloadBytesByDevice: { wasm: 41_000_000, webgpu: 77_000_000 },
    chunkLengthSeconds: 30,
    strideLengthSeconds: 5,
    maxDurationSeconds: 3 * 60 * 60,
    tier: 'tiny',
    note: 'Fastest, smallest download. Fine for clear English; weakest on Russian.',
  },
  {
    id: 'whisper-base-multilingual',
    label: 'Base',
    modelId: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    multilingual: true,
    devices: ['wasm', 'webgpu'],
    dtypeByDevice: { wasm: 'q8', webgpu: 'fp16' },
    downloadBytesByDevice: { wasm: 77_000_000, webgpu: 146_000_000 },
    chunkLengthSeconds: 30,
    strideLengthSeconds: 5,
    maxDurationSeconds: 3 * 60 * 60,
    tier: 'base',
    note: 'Noticeably better than Tiny on Russian while staying phone-friendly.',
  },
  {
    id: 'whisper-small-multilingual',
    label: 'Small',
    modelId: 'onnx-community/whisper-small',
    revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    multilingual: true,
    devices: ['wasm', 'webgpu'],
    dtypeByDevice: { wasm: 'q8', webgpu: 'fp16' },
    downloadBytesByDevice: { wasm: 249_000_000, webgpu: 485_000_000 },
    chunkLengthSeconds: 30,
    strideLengthSeconds: 5,
    maxDurationSeconds: 3 * 60 * 60,
    tier: 'small',
    desktopOnly: true,
    confirmBeforeDownload: true,
    note: 'Good accuracy on dictated Russian. Desktop only.',
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Large v3 Turbo',
    modelId: 'onnx-community/whisper-large-v3-turbo',
    revision: '360ebcde2559d60bb474678be3c1de9ef347d01a',
    multilingual: true,
    // fp16 would be 1.6 GB; q4 is both the smallest build here and the only one
    // that fits a browser cache without a fight.
    devices: ['wasm', 'webgpu'],
    dtypeByDevice: { wasm: 'q4', webgpu: 'q4' },
    downloadBytesByDevice: { wasm: 759_000_000, webgpu: 759_000_000 },
    chunkLengthSeconds: 30,
    strideLengthSeconds: 5,
    maxDurationSeconds: 3 * 60 * 60,
    tier: 'large',
    desktopOnly: true,
    confirmBeforeDownload: true,
    note: 'Best quality available here. Distilled from large-v3 — faster than Medium and stronger on Russian. Large download.',
  },
] as const;

export const DEFAULT_PROFILE_ID = MODEL_PROFILES[0].id;

/**
 * Profiles offered on this device. Heavy weights are withheld on mobile rather
 * than offered and then killed by the OS halfway through loading.
 */
export function availableProfiles(isMobile: boolean): ModelProfile[] {
  return MODEL_PROFILES.filter((profile) => !(isMobile && profile.desktopOnly));
}

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
 * Bytes fetched on first use for a given device. The weights differ per dtype,
 * so quoting one number for both runtimes would always be wrong for one of them.
 */
export function downloadBytesFor(profile: ModelProfile, device: 'wasm' | 'webgpu'): number {
  return profile.downloadBytesByDevice[device];
}

