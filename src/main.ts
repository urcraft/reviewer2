import './style.css';
import { mountUi } from './ui';
import { renderPdf } from './pdf';
import { findModel, loadModel, type LoadedModel, type ProgressInfo } from './models';
import { runReview } from './reviewer';
import { debugBus } from './debug';
import { loadSettings, saveSettings } from './settings';

const app = document.getElementById('app');
if (!app) throw new Error('#app not found');

let currentSettings = loadSettings();
let loaded: LoadedModel | null = null;
let loadedDevice: 'webgpu' | 'wasm' | null = null;
let loadingPromise: Promise<LoadedModel> | null = null;

const ui = mountUi(app, {
  onPickFile: (file) => {
    void review(file);
  },
  onSettingsChange: (s) => {
    const reloadNeeded =
      s.modelId !== currentSettings.modelId ||
      s.dtype !== currentSettings.dtype ||
      s.device !== currentSettings.device;
    currentSettings = s;
    saveSettings(s);
    if (reloadNeeded) {
      loaded = null;
      loadedDevice = null;
      loadingPromise = null;
      debugBus.info(`settings: ${s.modelId} (dtype ${s.dtype}, device ${s.device})`);
    }
  },
  onClearCache: async () => {
    await clearAllCaches();
    loaded = null;
    loadedDevice = null;
    loadingPromise = null;
    debugBus.info('cache: cleared all model storage');
  },
});

function chooseDevice(): 'webgpu' | 'wasm' {
  if (currentSettings.device === 'wasm') return 'wasm';
  if (currentSettings.device === 'webgpu') return 'webgpu';
  // 'auto': prefer webgpu when present
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
}

function isWebGpuError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /WebGPU|valid external Instance|compute pipeline|GPUDevice/i.test(msg);
}

async function ensureModel(deviceOverride?: 'webgpu' | 'wasm'): Promise<LoadedModel> {
  const device = deviceOverride ?? chooseDevice();
  if (loaded && loadedDevice === device) return loaded;
  if (loadingPromise && loadedDevice === device) return loadingPromise;

  const entry = findModel(currentSettings.modelId);
  const dtype = currentSettings.dtype === 'default' ? entry.defaultDtype : currentSettings.dtype;
  debugBus.info(`model: loading ${entry.id} (dtype ${dtype}, device ${device})`);
  ui.setState({
    phase: 'loading-model',
    phaseLabel: `Loading ${entry.label}${device === 'wasm' ? ' (CPU)' : ''}…`,
    progress: null,
    progressMeta: entry.sizeNote,
  });

  let lastFile = '';
  let aggregateLoaded = 0;
  let aggregateTotal = 0;
  const seenFiles = new Map<string, { loaded: number; total: number }>();

  const onProgress = (info: ProgressInfo) => {
    if (info.status === 'progress' && info.file) {
      if (info.file !== lastFile) {
        debugBus.info(`download: ${info.file}`);
        lastFile = info.file;
      }
      const total = info.total ?? 0;
      const cur = info.loaded ?? 0;
      seenFiles.set(info.file, { loaded: cur, total });
      aggregateLoaded = 0;
      aggregateTotal = 0;
      for (const v of seenFiles.values()) {
        aggregateLoaded += v.loaded;
        aggregateTotal += v.total;
      }
      const pct = aggregateTotal > 0 ? aggregateLoaded / aggregateTotal : null;
      ui.setState({
        progress: pct,
        progressMeta: aggregateTotal > 0
          ? `${formatMB(aggregateLoaded)} / ${formatMB(aggregateTotal)}`
          : info.file,
      });
    } else if (info.status === 'ready' || info.status === 'done') {
      debugBus.info(`download: ${info.file ?? ''} done`);
    } else if (info.status === 'initiate') {
      debugBus.info(`download: starting ${info.file ?? ''}`);
    }
  };

  loadedDevice = device;
  loadingPromise = (async () => {
    try {
      const m = await loadModel(entry, dtype, device, onProgress);
      debugBus.info(`model: loaded ${entry.id} on ${device}`);
      loaded = m;
      return m;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugBus.error(`model load failed: ${msg}`);
      loadingPromise = null;
      loadedDevice = null;
      throw err;
    }
  })();

  return loadingPromise;
}

async function review(file: File) {
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

  // Render PDF first so the user sees their file confirmed immediately.
  let canvases: OffscreenCanvas[];
  try {
    const { rendered, totalPages, thumbnailUrl } = await renderPdf(file, currentSettings.maxPages);
    canvases = rendered;
    debugBus.info(`pdf: ${totalPages} total page(s), rendered ${rendered.length}`);
    ui.setState({
      file: { name: file.name, pages: totalPages, thumbnailUrl },
    });
  } catch (err) {
    ui.setState({
      phase: 'error',
      phaseLabel: 'PDF parse failed.',
      error: errorMessage(err, 'Could not read that PDF. Is it actually a PDF?'),
    });
    return;
  }

  let model: LoadedModel;
  try {
    model = await ensureModel();
  } catch (err) {
    ui.setState({
      phase: 'error',
      phaseLabel: 'Model load failed.',
      progress: null,
      progressMeta: '',
      error: errorMessage(err, 'Could not load the model. Check your network or try a smaller one in settings.'),
    });
    return;
  }

  // run review
  ui.setState({
    phase: 'reviewing',
    phaseLabel: 'Roasting…',
    progress: null,
    progressMeta: '',
  });

  const stream = {
    buffer: '',
    onToken: (chunk: string) => {
      stream.buffer += chunk;
      debugBus.appendRaw(chunk);
      ui.setState({ reviewMarkdown: stream.buffer });
    },
    onStats: ({ tokens, elapsedMs }: { tokens: number; elapsedMs: number }) => {
      ui.setState({
        tokens,
        elapsedMs,
        progressMeta: `${tokens} tok · ${(tokens / (elapsedMs / 1000)).toFixed(1)} tok/s`,
      });
    },
  };

  try {
    await runReview(model, canvases, { onToken: stream.onToken, onStats: stream.onStats });
    ui.setState({
      phase: 'done',
      phaseLabel: 'Done. The verdict is in.',
      progress: 1,
    });
    return;
  } catch (err) {
    // Auto-fallback: if WebGPU blew up mid-generation and the user hasn't
    // pinned a specific device, reload on WASM and retry once.
    if (
      currentSettings.device === 'auto' &&
      loadedDevice === 'webgpu' &&
      isWebGpuError(err) &&
      stream.buffer.length === 0
    ) {
      debugBus.warn('WebGPU failed; retrying on WASM (CPU)…');
      loaded = null;
      loadedDevice = null;
      loadingPromise = null;
      ui.setState({
        phase: 'loading-model',
        phaseLabel: 'WebGPU failed — retrying on CPU…',
        progress: null,
        progressMeta: '',
      });
      try {
        const wasmModel = await ensureModel('wasm');
        ui.setState({
          phase: 'reviewing',
          phaseLabel: 'Roasting on CPU (slower)…',
          progress: null,
          progressMeta: '',
        });
        await runReview(wasmModel, canvases, { onToken: stream.onToken, onStats: stream.onStats });
        ui.setState({
          phase: 'done',
          phaseLabel: 'Done. The verdict is in. (CPU)',
          progress: 1,
        });
        return;
      } catch (err2) {
        ui.setState({
          phase: 'error',
          phaseLabel: 'Generation failed (CPU fallback also failed).',
          error: errorMessage(err2, 'Both WebGPU and CPU paths failed. Try a smaller model in settings.'),
        });
        return;
      }
    }
    ui.setState({
      phase: 'error',
      phaseLabel: 'Generation failed.',
      error: errorMessage(err, 'Something blew up during generation. Check the debug log.'),
    });
  }
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return `${fallback}\n\n${err.message}`;
  return fallback;
}

async function clearAllCaches() {
  // Wipe IndexedDB databases used by transformers.js for model files.
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
  // Also wipe CacheStorage entries that transformers.js may use.
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
}

// surface settings change source-of-truth from ui
currentSettings = ui.getSettings();
