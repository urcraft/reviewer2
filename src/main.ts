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
let loadingPromise: Promise<LoadedModel> | null = null;

const ui = mountUi(app, {
  onPickFile: (file) => {
    void review(file);
  },
  onSettingsChange: (s) => {
    const modelChanged = s.modelId !== currentSettings.modelId || s.dtype !== currentSettings.dtype;
    currentSettings = s;
    saveSettings(s);
    if (modelChanged) {
      loaded = null;
      loadingPromise = null;
      debugBus.info(`settings: model changed to ${s.modelId} (dtype ${s.dtype})`);
    }
  },
  onClearCache: async () => {
    await clearAllCaches();
    loaded = null;
    loadingPromise = null;
    debugBus.info('cache: cleared all model storage');
  },
});

async function ensureModel(): Promise<LoadedModel> {
  if (loaded) return loaded;
  if (loadingPromise) return loadingPromise;

  const entry = findModel(currentSettings.modelId);
  const dtype = currentSettings.dtype === 'default' ? entry.defaultDtype : currentSettings.dtype;
  debugBus.info(`model: loading ${entry.id} (dtype ${dtype}, device webgpu)`);
  ui.setState({
    phase: 'loading-model',
    phaseLabel: `Loading ${entry.label}…`,
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

  loadingPromise = (async () => {
    try {
      const m = await loadModel(entry, dtype, onProgress);
      debugBus.info(`model: loaded ${entry.id}`);
      loaded = m;
      return m;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugBus.error(`model load failed: ${msg}`);
      loadingPromise = null;
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

  let buffer = '';
  try {
    await runReview(model, canvases, {
      onToken: (chunk) => {
        buffer += chunk;
        debugBus.appendRaw(chunk);
        ui.setState({ reviewMarkdown: buffer });
      },
      onStats: ({ tokens, elapsedMs }) => {
        ui.setState({
          tokens,
          elapsedMs,
          progressMeta: `${tokens} tok · ${(tokens / (elapsedMs / 1000)).toFixed(1)} tok/s`,
        });
      },
    });
    ui.setState({
      phase: 'done',
      phaseLabel: 'Done. The verdict is in.',
      progress: 1,
    });
  } catch (err) {
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
