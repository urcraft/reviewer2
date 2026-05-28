import './style.css';
import { mountUi } from './ui';
import { renderPdf, stitchPages } from './pdf';
import { findModel, type Dtype } from './model-registry';
import { debugBus } from './debug';
import { loadSettings, saveSettings } from './settings';
import { REVIEWER_2_SYSTEM_PROMPT, REVIEWER_2_USER_PROMPT } from './prompts';
import type { PageImage, WorkerResponse, Device } from './worker-protocol';

const app = document.getElementById('app');
if (!app) throw new Error('#app not found');

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

let currentSettings = loadSettings();

const ui = mountUi(app, {
  onPickFile: (file) => {
    void review(file);
  },
  onStop: () => {
    worker.postMessage({ type: 'interrupt' });
  },
  onSettingsChange: (s) => {
    currentSettings = s;
    saveSettings(s);
  },
  onClearCache: async () => {
    await clearAllCaches();
    debugBus.info('cache: cleared all model storage');
  },
});
currentSettings = ui.getSettings();

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

worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
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
});

// ---- helpers ----------------------------------------------------------------

function chooseDevice(): Device {
  if (currentSettings.device === 'wasm') return 'wasm';
  if (currentSettings.device === 'webgpu') return 'webgpu';
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
}

function isQ4Dtype(d: string): boolean {
  return d === 'q4' || d === 'q4f16';
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
      maxNewTokens: 1024,
    });
  });
}

// ---- main flow --------------------------------------------------------------

async function review(file: File) {
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

  // Qwen2-VL's transformers.js processor only handles one image — stitch first.
  if (entry.singleImage && pages.length > 1) {
    pages = [stitchPages(pages)];
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

  // Load model (with WebGPU→WASM/q8 fallback if needed).
  try {
    await ensureModel(device, dtype);
  } catch (err) {
    if (device === 'webgpu' && currentSettings.device === 'auto' && (err as { isWebGpu?: boolean }).isWebGpu) {
      const fb: Dtype = isQ4Dtype(dtype) ? 'q8' : dtype;
      debugBus.warn(`WebGPU load failed; retrying on CPU (${fb})…`);
      try {
        await ensureModel('wasm', fb);
      } catch (err2) {
        ui.setState({
          phase: 'error',
          phaseLabel: 'Model load failed.',
          error: errorMessage(err2, 'Could not load the model on WebGPU or CPU. Try a smaller model in settings.'),
        });
        return;
      }
    } else {
      ui.setState({
        phase: 'error',
        phaseLabel: 'Model load failed.',
        error: errorMessage(err, 'Could not load the model. Check your network or try a smaller one in settings.'),
      });
      return;
    }
  }

  // Generate.
  ui.setState({ phase: 'reviewing', phaseLabel: 'Roasting…', progress: null, progressMeta: '' });
  try {
    const r = await runGeneration(pages, stream.onToken);
    ui.setState({
      phase: 'done',
      phaseLabel: r.interrupted ? 'Stopped.' : 'Done. The verdict is in.',
      progress: 1,
    });
  } catch (err) {
    const wgpu = (err as { isWebGpu?: boolean }).isWebGpu;
    if (wgpu && currentSettings.device === 'auto' && stream.buffer.length === 0) {
      const fb: Dtype = isQ4Dtype(dtype) ? 'q8' : dtype;
      debugBus.warn(`WebGPU generation failed; retrying on CPU (${fb})…`);
      ui.setState({ phase: 'loading-model', phaseLabel: `WebGPU failed — retrying on CPU (${fb})…`, progress: null, progressMeta: '' });
      try {
        await ensureModel('wasm', fb);
        ui.setState({ phase: 'reviewing', phaseLabel: 'Roasting on CPU (slower)…', progress: null, progressMeta: '' });
        const r = await runGeneration(pages, stream.onToken);
        ui.setState({
          phase: 'done',
          phaseLabel: r.interrupted ? 'Stopped.' : 'Done. The verdict is in. (CPU)',
          progress: 1,
        });
        return;
      } catch (err2) {
        ui.setState({
          phase: 'error',
          phaseLabel: 'Both WebGPU and CPU paths failed.',
          error: errorMessage(err2, 'Try a different model in settings — SmolVLM 256M is the most reliable.'),
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
