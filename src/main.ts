import './style.css';
import { mountUi } from './ui';
import { renderPdf, stitchPages } from './pdf';
import { findModel, type Dtype, type ModelEntry } from './model-registry';
import { debugBus } from './debug';
import { loadSettings, saveSettings } from './settings';
import { REVIEWER_2_SYSTEM_PROMPT, REVIEWER_2_USER_PROMPT, REVIEWER_2_PREFILL } from './prompts';
import { probeGpu, estimateLargestBufferBytes, formatGB, type GpuInfo } from './gpu-info';
import type { PageImage, WorkerResponse, Device } from './worker-protocol';

const app = document.getElementById('app');
if (!app) throw new Error('#app not found');

let worker = spawnWorker();
// True after any WebGPU/capacity failure — the device may be dead, so the
// next run respawns the worker from scratch to get a clean GPU context.
let workerNeedsReset = false;

function spawnWorker(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.addEventListener('message', (e: MessageEvent<WorkerResponse>) => onWorkerMessage(e));
  return w;
}

function resetWorker(reason: string) {
  debugBus.warn(`worker reset (${reason}) — fresh WebGPU device`);
  try { worker.terminate(); } catch { /* ignore */ }
  worker = spawnWorker();
  workerNeedsReset = false;
  pending = {};
}

let currentSettings = loadSettings();

const ui = mountUi(app, {
  onPickFile: (file) => {
    void review(file);
  },
  onStop: () => {
    worker.postMessage({ type: 'interrupt' });
  },
  onSettingsChange: (s) => {
    const modelChanged = s.modelId !== currentSettings.modelId;
    currentSettings = s;
    saveSettings(s);
    // If we crashed earlier, force a fresh worker on the next run so the new
    // model doesn't inherit a dead GPU device. Marking instead of resetting
    // immediately avoids killing an in-progress download.
    if (modelChanged && workerNeedsReset) {
      debugBus.info('model changed after failure — worker will be reset on next run');
    }
  },
  onClearCache: async () => {
    await clearAllCaches();
    resetWorker('cache cleared');
    debugBus.info('cache: cleared all model storage');
  },
});
currentSettings = ui.getSettings();

// Probe WebGPU once at startup; log + push into the UI so the model picker can
// warn when an entry won't fit in the device's per-buffer budget.
let gpuInfo: GpuInfo | null = null;
void (async () => {
  gpuInfo = await probeGpu();
  if (gpuInfo.available) {
    debugBus.info(
      `webgpu: ${gpuInfo.vendor ?? '?'}/${gpuInfo.architecture ?? '?'} · maxBufferSize ${formatGB(gpuInfo.maxBufferBytes)} · maxStorageBufferBindingSize ${formatGB(gpuInfo.maxStorageBufferBindingBytes)}`,
    );
  } else {
    debugBus.warn(`webgpu unavailable: ${gpuInfo.reason ?? 'unknown'}`);
  }
  ui.setGpuInfo(gpuInfo);
})();

// True when the model's largest buffer is too close to the GPU's per-buffer
// ceiling — the same check the UI uses for the "may not fit" chip.
function isCapacityConstrained(entry: ModelEntry): boolean {
  if (!gpuInfo?.available || !gpuInfo.maxBufferBytes) return false;
  return estimateLargestBufferBytes(entry.sizeNote) > gpuInfo.maxBufferBytes * 0.85;
}

// ---- worker message pump ----------------------------------------------------

type Pending = {
  resolveLoad?: () => void;
  rejectLoad?: (e: Error & { isWebGpu?: boolean }) => void;
  resolveGen?: (r: { tokens: number; elapsedMs: number; interrupted: boolean }) => void;
  rejectGen?: (e: Error & { isWebGpu?: boolean }) => void;
  onToken?: (t: string) => void;
  onProgress?: (file: string, loaded: number, total: number) => void;
};
let pending: Pending = {};

function onWorkerMessage(e: MessageEvent<WorkerResponse>) {
  const msg = e.data;
  switch (msg.type) {
    case 'log':
      debugBus.log(msg.level, msg.message);
      break;
    case 'progress':
      pending.onProgress?.(msg.file, msg.loaded, msg.total);
      break;
    case 'loaded':
      pending.resolveLoad?.();
      break;
    case 'loadError': {
      const err = Object.assign(new Error(msg.message), { isWebGpu: msg.isWebGpu });
      pending.rejectLoad?.(err);
      break;
    }
    case 'token':
      pending.onToken?.(msg.text);
      break;
    case 'generated':
      pending.resolveGen?.({ tokens: msg.tokens, elapsedMs: msg.elapsedMs, interrupted: msg.interrupted });
      break;
    case 'generateError': {
      const err = Object.assign(new Error(msg.message), { isWebGpu: msg.isWebGpu });
      pending.rejectGen?.(err);
      break;
    }
  }
}

// ---- helpers ----------------------------------------------------------------

function chooseDevice(): Device {
  if (currentSettings.device === 'wasm') return 'wasm';
  if (currentSettings.device === 'webgpu') return 'webgpu';
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
}

function isQ4Dtype(d: string): boolean {
  return d === 'q4' || d === 'q4f16';
}

// Out-of-memory / device-lost signatures from WebGPU and onnxruntime-web.
function isCapacityError(msg: string): boolean {
  return /device is lost|out of memory|failed to allocate|can't create a session|mapasync/i.test(msg);
}

function isWebGpuish(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    Boolean((err as { isWebGpu?: boolean }).isWebGpu) ||
    /device is lost|mapasync|webgpu|compute pipeline|valid external instance|gpudevice/.test(msg)
  );
}

// WASM can't hold a 2B-class model (single >1GB buffer), so a CPU retry is
// pointless for the larger models — only the tiny/small ones can fall back.
function canFallBackToWasm(entry: ModelEntry): boolean {
  return entry.tier === 'tiny' || entry.tier === 'small';
}

function capacityMessage(entry: ModelEntry, raw: string): string {
  const need = estimateLargestBufferBytes(entry.sizeNote);
  const budget = gpuInfo?.maxBufferBytes;
  const sizeLine =
    need && budget
      ? `Your GPU's per-buffer ceiling is ${formatGB(budget)}; "${entry.label}" needs ~${formatGB(need)} just for weights, and the KV cache + activations during generation push past the limit. This is a hard WebGPU/driver cap, not a global memory budget — closing tabs won't help.`
      : `“${entry.label}” exceeded the GPU's per-buffer budget on this device.`;
  return (
    `${sizeLine}\n\n` +
    `Open settings (⚙) and pick a smaller model — SmolVLM 500M (~600 MB) is the next-best quality that fits, or SmolVLM 256M for max safety.\n\n(${raw})`
  );
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return `${fallback}\n\n${err.message}`;
  return fallback;
}

function ensureModel(device: Device, dtype: Dtype): Promise<void> {
  const entry = findModel(currentSettings.modelId);
  ui.setState({
    phase: 'loading-model',
    phaseLabel: `Loading ${entry.label}${device === 'wasm' ? ' (CPU)' : ''}…`,
    progress: null,
    progressMeta: entry.sizeNote,
  });

  const seen = new Map<string, { loaded: number; total: number }>();
  pending.onProgress = (file, loaded, total) => {
    seen.set(file, { loaded, total });
    let l = 0;
    let t = 0;
    for (const v of seen.values()) {
      l += v.loaded;
      t += v.total;
    }
    ui.setState({
      progress: t > 0 ? l / t : null,
      progressMeta: t > 0 ? `${formatMB(l)} / ${formatMB(t)}` : file,
    });
  };

  return new Promise<void>((resolve, reject) => {
    pending.resolveLoad = resolve;
    pending.rejectLoad = reject;
    worker.postMessage({ type: 'load', modelId: entry.id, dtype, device });
  });
}

function runGeneration(
  images: PageImage[],
  maxNewTokens: number,
  onToken: (t: string) => void,
): Promise<{ tokens: number; elapsedMs: number; interrupted: boolean }> {
  pending.onToken = onToken;
  return new Promise((resolve, reject) => {
    pending.resolveGen = resolve;
    pending.rejectGen = reject;
    worker.postMessage({
      type: 'generate',
      images,
      systemPrompt: REVIEWER_2_SYSTEM_PROMPT,
      userPrompt: REVIEWER_2_USER_PROMPT,
      prefill: REVIEWER_2_PREFILL,
      maxNewTokens,
    });
  });
}

// ---- main flow --------------------------------------------------------------

async function review(file: File) {
  // A previous WebGPU crash leaves the device in a dead state for the
  // lifetime of the worker — so respawn before doing anything else.
  if (workerNeedsReset) resetWorker('previous WebGPU failure');
  pending = {};
  debugBus.resetRaw();
  ui.setState({
    reviewMarkdown: '',
    tokens: 0,
    elapsedMs: 0,
    error: null,
    phase: 'rendering-pdf',
    phaseLabel: 'Rendering pages…',
    progress: null,
    progressMeta: '',
  });

  let pages: PageImage[];
  try {
    const { pages: rendered, totalPages, thumbnailUrl } = await renderPdf(file, currentSettings.maxPages);
    pages = rendered;
    debugBus.info(`pdf: ${totalPages} total page(s), rendered ${rendered.length}`);
    ui.setState({ file: { name: file.name, pages: totalPages, thumbnailUrl } });
  } catch (err) {
    ui.setState({
      phase: 'error',
      phaseLabel: 'PDF parse failed.',
      error: errorMessage(err, 'Could not read that PDF. Is it actually a PDF?'),
    });
    return;
  }

  const entry = findModel(currentSettings.modelId);
  const dtype: Dtype =
    currentSettings.dtype === 'default' ? entry.defaultDtype : currentSettings.dtype;
  const device = chooseDevice();

  // When the model is right at the GPU's per-buffer ceiling, shrink the inputs
  // so the KV cache + vision activations don't push past the limit:
  // smaller stitched image, tighter token budget.
  const constrained = isCapacityConstrained(entry);
  const stitchCap = constrained ? 1_000_000 : 2_000_000;
  const maxNewTokens = constrained ? 384 : 1024;
  if (constrained) {
    debugBus.warn(
      `capacity-constrained: shrinking inputs (image≤${stitchCap.toLocaleString()}px, ${maxNewTokens} tokens)`,
    );
  }

  // Qwen2-VL's transformers.js processor only handles one image — stitch first.
  if (entry.singleImage && pages.length > 1) {
    pages = [stitchPages(pages, 16, stitchCap)];
    debugBus.info(`pages stitched into 1 image for ${entry.label}`);
  }

  const stream = {
    buffer: '',
    tokens: 0,
    start: 0,
    onToken(chunk: string) {
      if (stream.start === 0) stream.start = performance.now();
      stream.buffer += chunk;
      stream.tokens += 1;
      debugBus.appendRaw(chunk);
      const elapsedMs = performance.now() - stream.start;
      ui.setState({
        reviewMarkdown: stream.buffer,
        tokens: stream.tokens,
        elapsedMs,
        progressMeta: `${stream.tokens} tok · ${(stream.tokens / (elapsedMs / 1000)).toFixed(1)} tok/s`,
      });
    },
  };

  // One full attempt on a device: load → generate → mark done.
  async function attempt(dev: Device, dt: Dtype) {
    await ensureModel(dev, dt);
    ui.setState({
      phase: 'reviewing',
      phaseLabel: dev === 'wasm' ? 'Roasting on CPU (slower)…' : 'Roasting…',
      progress: null,
      progressMeta: '',
    });
    const r = await runGeneration(pages, maxNewTokens, stream.onToken);
    ui.setState({
      phase: 'done',
      phaseLabel: r.interrupted ? 'Stopped.' : `Done. The verdict is in.${dev === 'wasm' ? ' (CPU)' : ''}`,
      progress: 1,
    });
  }

  function showFailure(err: unknown, entry: ModelEntry) {
    const raw = err instanceof Error ? err.message : String(err);
    if (isWebGpuish(err) || isCapacityError(raw)) workerNeedsReset = true;
    if (isCapacityError(raw)) {
      ui.setState({ phase: 'error', phaseLabel: 'Out of memory.', error: capacityMessage(entry, raw) });
    } else {
      ui.setState({
        phase: 'error',
        phaseLabel: 'Generation failed.',
        error: errorMessage(err, 'Something blew up. Check the debug log, or try a smaller model in settings.'),
      });
    }
  }

  try {
    await attempt(device, dtype);
  } catch (err) {
    const eligibleForWasm =
      device === 'webgpu' &&
      currentSettings.device === 'auto' &&
      isWebGpuish(err) &&
      stream.buffer.length === 0 &&
      canFallBackToWasm(entry);

    if (eligibleForWasm) {
      const fb: Dtype = isQ4Dtype(dtype) ? 'q8' : dtype;
      debugBus.warn(`WebGPU failed; retrying on CPU (${fb})…`);
      // Respawn before the CPU retry — the WebGPU device is dead and any
      // shared ORT state in the worker may be in a bad mood.
      resetWorker('WebGPU failure before CPU retry');
      ui.setState({
        phase: 'loading-model',
        phaseLabel: `WebGPU failed — retrying on CPU (${fb})…`,
        progress: null,
        progressMeta: '',
      });
      try {
        await attempt('wasm', fb);
      } catch (err2) {
        showFailure(err2, entry);
      }
      return;
    }

    // Large model on WebGPU: a WASM retry would just download ~1.5GB and fail
    // on a single oversized buffer. Skip it and tell the user what to do.
    if (isWebGpuish(err) && !canFallBackToWasm(entry) && stream.buffer.length === 0) {
      debugBus.warn(`${entry.label} failed on WebGPU and is too large for a CPU retry.`);
      workerNeedsReset = true;
      ui.setState({
        phase: 'error',
        phaseLabel: 'Out of memory.',
        error: capacityMessage(entry, err instanceof Error ? err.message : String(err)),
      });
      return;
    }

    showFailure(err, entry);
  }
}

async function clearAllCaches() {
  if ('databases' in indexedDB) {
    const dbs = await (indexedDB as IDBFactory & { databases: () => Promise<{ name?: string }[]> }).databases();
    for (const d of dbs) {
      if (d.name) {
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(d.name!);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      }
    }
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
}
