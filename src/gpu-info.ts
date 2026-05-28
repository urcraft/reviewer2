export type GpuInfo = {
  available: boolean;
  reason?: string;
  vendor?: string;
  architecture?: string;
  description?: string;
  maxBufferBytes?: number;
  maxStorageBufferBindingBytes?: number;
};

let cached: GpuInfo | null = null;

export async function probeGpu(): Promise<GpuInfo> {
  if (cached) return cached;
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    cached = { available: false, reason: 'navigator.gpu not present' };
    return cached;
  }
  try {
    const gpu = (navigator as unknown as {
      gpu: {
        requestAdapter: (opts?: { powerPreference?: string }) => Promise<{
          info?: { vendor?: string; architecture?: string; description?: string };
          limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
        } | null>;
      };
    }).gpu;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      cached = {
        available: false,
        reason: 'No WebGPU adapter — the GPU process may have crashed from an earlier OOM. Restart your browser.',
      };
      return cached;
    }
    const info = adapter.info ?? {};
    cached = {
      available: true,
      vendor: info.vendor,
      architecture: info.architecture,
      description: info.description,
      maxBufferBytes: adapter.limits.maxBufferSize,
      maxStorageBufferBindingBytes: adapter.limits.maxStorageBufferBindingSize,
    };
    return cached;
  } catch (err) {
    cached = { available: false, reason: err instanceof Error ? err.message : String(err) };
    return cached;
  }
}

export function formatGB(bytes?: number): string {
  if (!bytes) return '?';
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

// Rough estimate of the single largest weight tensor we'll ask the GPU to hold,
// from the model registry's sizeNote (e.g. "~1.5 GB · q4f16"). Conservative: we
// take the model-level estimate as a stand-in for the biggest internal buffer.
export function estimateLargestBufferBytes(sizeNote: string): number {
  const m = sizeNote.match(/([\d.]+)\s*GB/i);
  if (m) return Math.round(parseFloat(m[1]) * 1e9);
  const mb = sizeNote.match(/([\d.]+)\s*MB/i);
  if (mb) return Math.round(parseFloat(mb[1]) * 1e6);
  return 0;
}
