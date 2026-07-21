/**
 * Platform capability detection shared by the UI thread and the inference
 * Worker.
 *
 * This lives outside `audio/` and `inference/` on purpose: both need it, and
 * having the audio layer reach into the inference layer for a User-Agent check
 * was an inversion waiting to become a cycle.
 */

/** Stable reason codes reported in diagnostics when WebGPU is not used. */
export type WebGpuRejection =
  | 'WEBGPU_API_MISSING'
  | 'WEBGPU_NO_ADAPTER'
  | 'WEBGPU_ADAPTER_ERROR'
  | 'WEBGPU_MOBILE_POLICY'
  | 'WEBGPU_NO_SHADER_F16';

export type WebGpuProbe =
  | { usable: true; maxStorageBufferBindingSize: number; shaderF16: boolean }
  | { usable: false; rejection: WebGpuRejection; maxStorageBufferBindingSize?: number };

type AdapterLike = {
  limits?: { maxStorageBufferBindingSize?: number };
  features?: { has(name: string): boolean };
};

/**
 * True for phones and tablets.
 *
 * Deliberately avoids `navigator.maxTouchPoints`: `WorkerNavigator` does not
 * expose it, so the usual iPadOS check silently evaluates to false inside the
 * Worker — which is where the runtime decision is actually made. iPadOS Safari
 * reports a desktop UA, so it is matched through its distinctive
 * "Macintosh + Mobile/" and touch-Mac tokens instead.
 */
export function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';

  if (/iPhone|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
  if (/iPad/i.test(ua)) return true;
  // iPadOS 13+ desktop-mode Safari: "Macintosh; Intel Mac OS X" plus a mobile
  // build token that no desktop Safari sends.
  if (/Macintosh/.test(ua) && /Mobile\/|Version\/[\d.]+ Mobile/.test(ua)) return true;
  if (/Mobi/i.test(ua)) return true;

  return false;
}

/**
 * Asks the platform whether WebGPU is genuinely usable for our workload.
 *
 * Note on limits: `maxStorageBufferBindingSize` is reported for diagnostics but
 * is deliberately *not* used as a gate. Its spec default is exactly 128 MiB, so
 * any conformant adapter clears a 128 MiB threshold and the check would never
 * fire — while a stricter threshold would reject working hardware. What
 * actually matters for the fp16 profile is the `shader-f16` feature.
 */
export async function probeWebGpu(): Promise<WebGpuProbe> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return { usable: false, rejection: 'WEBGPU_API_MISSING' };
  }

  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<AdapterLike | null> } })
      .gpu;
    const adapter = await gpu?.requestAdapter();
    if (!adapter) {
      return { usable: false, rejection: 'WEBGPU_NO_ADAPTER' };
    }

    const maxStorageBufferBindingSize = adapter.limits?.maxStorageBufferBindingSize ?? 0;
    const shaderF16 = adapter.features?.has('shader-f16') ?? false;

    if (!shaderF16) {
      return { usable: false, rejection: 'WEBGPU_NO_SHADER_F16', maxStorageBufferBindingSize };
    }

    return { usable: true, maxStorageBufferBindingSize, shaderF16 };
  } catch {
    return { usable: false, rejection: 'WEBGPU_ADAPTER_ERROR' };
  }
}

/**
 * Whether `auto` may select WebGPU. Mobile is excluded by policy: the GPU path
 * loads the fp16 weights, and the resulting peak is what gets mobile tabs
 * killed by the OS.
 */
export function autoMayUseWebGpu(): boolean {
  return !isMobileUA();
}
