import type { ModelProfile } from './types';

/** Prototype profiles — Hub delivery with pinned package versions. */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'whisper-tiny-multilingual-wasm',
    label: 'Whisper Tiny (multilingual)',
    modelId: 'onnx-community/whisper-tiny',
    revision: 'main',
    multilingual: true,
    approximateDownloadBytes: 77_000_000,
    devices: ['wasm', 'webgpu'],
    dtypeByDevice: {
      wasm: 'q8',
      webgpu: 'fp32',
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
