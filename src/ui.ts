import { MODEL_REGISTRY, findModel, tierHint, type Dtype } from './model-registry';
import { loadSettings, saveSettings, type Settings, type Device } from './settings';
import { debugBus, formatEvents } from './debug';
import { renderMarkdown } from './markdown';

type Phase = 'idle' | 'loading-model' | 'rendering-pdf' | 'reviewing' | 'done' | 'error';

export type UiState = {
  phase: Phase;
  phaseLabel: string;
  progress: number | null; // 0–1, or null for indeterminate
  progressMeta: string;
  reviewMarkdown: string;
  file: { name: string; pages: number; thumbnailUrl: string } | null;
  tokens: number;
  elapsedMs: number;
  error: string | null;
};

export type UiCallbacks = {
  onPickFile: (file: File) => void;
  onStop: () => void;
  onSettingsChange: (s: Settings) => void;
  onClearCache: () => Promise<void>;
};

export type Ui = {
  root: HTMLElement;
  setState: (patch: Partial<UiState>) => void;
  getSettings: () => Settings;
  el: { reviewBody: HTMLElement };
};

const DTYPE_OPTIONS: Array<Dtype | 'default'> = ['default', 'q4', 'q4f16', 'q8', 'fp16'];
const DEVICE_OPTIONS: Array<{ value: Device; label: string }> = [
  { value: 'auto', label: 'auto (WebGPU with CPU fallback)' },
  { value: 'webgpu', label: 'WebGPU only' },
  { value: 'wasm', label: 'CPU (WASM) only' },
];

export function mountUi(host: HTMLElement, cbs: UiCallbacks): Ui {
  let settings = loadSettings();
  let state: UiState = {
    phase: 'idle',
    phaseLabel: 'Drop a PDF to begin.',
    progress: null,
    progressMeta: '',
    reviewMarkdown: '',
    file: null,
    tokens: 0,
    elapsedMs: 0,
    error: null,
  };
  let debugTab: 'raw' | 'events' = 'raw';

  // ---------- shell ----------
  host.innerHTML = '';
  const shell = el('div', { id: 'shell' });
  host.appendChild(shell);

  // ---------- header ----------
  const debugBtn = el('button', {
    className: 'icon-btn',
    title: 'Toggle debug pane',
    'aria-pressed': String(settings.showDebug),
    onclick: () => {
      settings = { ...settings, showDebug: !settings.showDebug };
      saveSettings(settings);
      cbs.onSettingsChange(settings);
      render();
    },
  }, ['🐛']);

  const settingsBtn = el('button', {
    className: 'icon-btn',
    title: 'Settings',
    onclick: openDrawer,
  }, ['⚙']);

  const header = el('header', { className: 'header' }, [
    el('div', { className: 'brand' }, [
      el('span', { className: 'brand-mark' }, ['2']),
      el('div', null, [
        el('div', { className: 'brand-title' }, ['Reviewer 2']),
        el('div', { className: 'brand-tag' }, ["your paper's harshest critic"]),
      ]),
    ]),
    el('div', { className: 'header-actions' }, [debugBtn, settingsBtn]),
  ]);
  shell.appendChild(header);

  // ---------- main ----------
  const main = el('main', { className: 'main' });
  shell.appendChild(main);

  const centerCol = el('section', { className: 'center-col' });
  const centerInner = el('div', { className: 'center-inner' });
  centerCol.appendChild(centerInner);
  main.appendChild(centerCol);

  // upload card swap target
  const uploadSlot = el('div');
  centerInner.appendChild(uploadSlot);

  // controls
  const modelSelect = el('select', {
    className: 'pill-select',
    title: 'Model',
    onchange: (e: Event) => {
      const id = (e.target as HTMLSelectElement).value;
      settings = { ...settings, modelId: id, dtype: 'default' };
      saveSettings(settings);
      cbs.onSettingsChange(settings);
      syncModelHint();
    },
  }) as HTMLSelectElement;
  for (const m of MODEL_REGISTRY) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = settings.modelId;

  const modelHint = el('div', { className: 'model-hint' });
  function syncModelHint() {
    const m = findModel(settings.modelId);
    modelHint.innerHTML = '';
    modelHint.appendChild(el('span', { className: `tier-chip tier-${m.tier}` }, [m.tier]));
    modelHint.appendChild(el('span', { className: 'model-hint-text' }, [`${tierHint(m)} · ${m.sizeNote}`]));
  }

  const pagesSlider = el('input', {
    type: 'range', min: '1', max: '10', step: '1',
    className: 'slider',
    value: String(settings.maxPages),
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      settings = { ...settings, maxPages: v };
      saveSettings(settings);
      cbs.onSettingsChange(settings);
      pagesVal.textContent = String(v);
    },
  }) as HTMLInputElement;
  const pagesVal = el('span', { className: 'slider-val' }, [String(settings.maxPages)]);

  const reviewBtn = el('button', {
    className: 'btn-primary',
    onclick: () => {
      if (isBusy()) {
        cbs.onStop();
      } else if (currentFile) {
        cbs.onPickFile(currentFile);
      }
    },
  }, ['Roast it']) as HTMLButtonElement;
  reviewBtn.disabled = true;

  const controls = el('div', { className: 'controls' }, [
    el('div', { className: 'control' }, [el('span', null, ['Model']), modelSelect]),
    el('div', { className: 'control' }, [el('span', null, ['Pages']), pagesSlider, pagesVal]),
    reviewBtn,
  ]);
  centerInner.appendChild(controls);
  centerInner.appendChild(modelHint);
  syncModelHint();

  // status
  const statusPhase = el('span', { className: 'status-phase' }, ['']);
  const statusMeta = el('span', { className: 'status-meta' }, ['']);
  const progressBar = el('div', { className: 'progress-bar' });
  const progress = el('div', { className: 'progress' }, [progressBar]);
  const status = el('div', { className: 'status' }, [
    el('div', { className: 'status-row' }, [statusPhase, statusMeta]),
    progress,
  ]);
  centerInner.appendChild(status);

  // review pane
  const reviewBody = el('div', { className: 'review-body' });
  const reviewEmpty = el('div', { className: 'review-empty' }, [
    'No paper, no roast. Drop a PDF above.',
  ]);
  const review = el('article', { className: 'review' }, [reviewEmpty]);
  centerInner.appendChild(review);

  // footer
  shell.appendChild(el('footer', { className: 'footer' }, [
    el('span', null, ['Runs entirely in your browser via '],),
    el('a', { href: 'https://github.com/huggingface/transformers.js', target: '_blank', rel: 'noopener' }, ['transformers.js']),
    el('span', null, [' · ']),
    el('a', { href: 'https://github.com/urcraft/reviewer2', target: '_blank', rel: 'noopener' }, ['source']),
  ]));

  // debug pane (created lazily on first render with showDebug)
  let debugPane: HTMLElement | null = null;
  let debugContent: HTMLElement | null = null;
  let debugStats: HTMLElement | null = null;
  let tabRawBtn: HTMLButtonElement | null = null;
  let tabEventsBtn: HTMLButtonElement | null = null;

  function buildDebugPane() {
    tabRawBtn = el('button', {
      className: 'debug-tab', 'aria-selected': 'true',
      onclick: () => { debugTab = 'raw'; renderDebug(); },
    }, ['Raw output']) as HTMLButtonElement;
    tabEventsBtn = el('button', {
      className: 'debug-tab', 'aria-selected': 'false',
      onclick: () => { debugTab = 'events'; renderDebug(); },
    }, ['Events']) as HTMLButtonElement;

    const copyBtn = el('button', {
      className: 'btn-ghost',
      onclick: async () => {
        const text = debugTab === 'raw' ? debugBus.raw : formatEvents(debugBus.events);
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        } catch {
          copyBtn.textContent = 'Failed';
        }
      },
    }, ['Copy']);

    debugStats = el('span', { className: 'debug-stats' }, ['']);
    debugContent = el('div', { className: 'debug-content empty' }, ['(empty)']);

    const tabs = el('div', { className: 'debug-tabs' }, [
      tabRawBtn, tabEventsBtn,
      el('div', { className: 'debug-actions' }, [debugStats, copyBtn]),
    ]);
    debugPane = el('aside', { className: 'debug' }, [tabs, debugContent]);
  }

  function renderDebug() {
    if (!debugPane || !debugContent || !debugStats || !tabRawBtn || !tabEventsBtn) return;
    tabRawBtn.setAttribute('aria-selected', String(debugTab === 'raw'));
    tabEventsBtn.setAttribute('aria-selected', String(debugTab === 'events'));
    const body = debugTab === 'raw' ? debugBus.raw : formatEvents(debugBus.events);
    if (body.length === 0) {
      debugContent.className = 'debug-content empty';
      debugContent.textContent = debugTab === 'raw' ? '(no output yet)' : '(no events yet)';
    } else if (debugTab === 'raw') {
      debugContent.className = 'debug-content';
      debugContent.textContent = body;
    } else {
      debugContent.className = 'debug-content';
      debugContent.innerHTML = '';
      for (const ev of debugBus.events) {
        const line = document.createElement('div');
        line.className = `event-${ev.level}`;
        line.textContent = `[${formatTs(ev.ts)}] ${ev.level.padEnd(5)} | ${ev.message}`;
        debugContent.appendChild(line);
      }
      debugContent.scrollTop = debugContent.scrollHeight;
    }
    const tps = state.elapsedMs > 0 ? (state.tokens / (state.elapsedMs / 1000)).toFixed(1) : '0.0';
    debugStats.textContent = state.tokens > 0
      ? `tokens: ${state.tokens} · ${(state.elapsedMs / 1000).toFixed(1)}s · ${tps} tok/s`
      : '';
  }

  debugBus.subscribe(renderDebug);

  // ---------- settings drawer ----------
  const drawer = buildDrawer();
  const scrim = el('div', { className: 'scrim', onclick: closeDrawer });
  document.body.appendChild(scrim);
  document.body.appendChild(drawer.root);

  function openDrawer() {
    drawer.refresh();
    scrim.classList.add('open');
    drawer.root.classList.add('open');
  }
  function closeDrawer() {
    scrim.classList.remove('open');
    drawer.root.classList.remove('open');
  }

  function buildDrawer() {
    const modelSel = el('select', {
      className: 'field-select',
      onchange: (e: Event) => {
        const id = (e.target as HTMLSelectElement).value;
        settings = { ...settings, modelId: id, dtype: 'default' };
        saveSettings(settings);
        cbs.onSettingsChange(settings);
        modelSelect.value = id;
        modelHelp.textContent = describeModel(id);
        syncModelHint();
      },
    }) as HTMLSelectElement;
    for (const m of MODEL_REGISTRY) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.label}  (${m.sizeNote})`;
      modelSel.appendChild(opt);
    }
    const modelHelp = el('div', { className: 'field-help' }, [describeModel(settings.modelId)]);

    const pagesIn = el('input', {
      type: 'range', min: '1', max: '10', step: '1',
      className: 'slider',
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        settings = { ...settings, maxPages: v };
        saveSettings(settings);
        cbs.onSettingsChange(settings);
        pagesValD.textContent = String(v);
        pagesSlider.value = String(v);
        pagesVal.textContent = String(v);
      },
    }) as HTMLInputElement;
    const pagesValD = el('span', { className: 'slider-val' }, [String(settings.maxPages)]);

    const dtypeSel = el('select', {
      className: 'field-select',
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value as Dtype | 'default';
        settings = { ...settings, dtype: v };
        saveSettings(settings);
        cbs.onSettingsChange(settings);
      },
    }) as HTMLSelectElement;
    for (const d of DTYPE_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d === 'default' ? 'model default' : d;
      dtypeSel.appendChild(opt);
    }

    const deviceSel = el('select', {
      className: 'field-select',
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value as Device;
        settings = { ...settings, device: v };
        saveSettings(settings);
        cbs.onSettingsChange(settings);
      },
    }) as HTMLSelectElement;
    for (const d of DEVICE_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = d.value;
      opt.textContent = d.label;
      deviceSel.appendChild(opt);
    }

    const clearBtn = el('button', {
      className: 'btn-ghost',
      onclick: async () => {
        clearBtn.textContent = 'Clearing…';
        await cbs.onClearCache();
        clearBtn.textContent = 'Cleared';
        setTimeout(() => { clearBtn.textContent = 'Clear cached models'; }, 1500);
      },
    }, ['Clear cached models']);

    const body = el('div', { className: 'drawer-body' }, [
      el('div', { className: 'field' }, [
        el('label', { className: 'field-label' }, ['Model']),
        modelSel,
        modelHelp,
      ]),
      el('div', { className: 'field' }, [
        el('label', { className: 'field-label' }, ['Pages to send']),
        el('div', { className: 'field-row' }, [pagesIn, pagesValD]),
        el('div', { className: 'field-help' }, [
          'Tiny models work best with fewer pages. Title + abstract + intro is usually enough for a roast.',
        ]),
      ]),
      el('div', { className: 'field' }, [
        el('label', { className: 'field-label' }, ['Precision (dtype)']),
        dtypeSel,
        el('div', { className: 'field-help' }, [
          'Lower precision = smaller download + faster, but rougher output. Stick with the model default unless you know what you want.',
        ]),
      ]),
      el('div', { className: 'field' }, [
        el('label', { className: 'field-label' }, ['Device']),
        deviceSel,
        el('div', { className: 'field-help' }, [
          'WebGPU is much faster but some browsers / models hit driver bugs (look for "compute pipeline" errors). Auto falls back to CPU if WebGPU blows up mid-generation.',
        ]),
      ]),
      el('div', { className: 'field' }, [
        el('label', { className: 'field-label' }, ['Cache']),
        clearBtn,
        el('div', { className: 'field-help' }, [
          'Models live in IndexedDB after first download. Clear if you want to free space or force a re-download.',
        ]),
      ]),
    ]);

    const root = el('div', {
      className: 'drawer',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Settings',
    }, [
      el('div', { className: 'drawer-header' }, [
        el('div', { className: 'drawer-title' }, ['Settings']),
        el('button', { className: 'icon-btn', onclick: closeDrawer, 'aria-label': 'Close' }, ['×']),
      ]),
      body,
    ]);

    function refresh() {
      modelSel.value = settings.modelId;
      pagesIn.value = String(settings.maxPages);
      pagesValD.textContent = String(settings.maxPages);
      dtypeSel.value = settings.dtype;
      deviceSel.value = settings.device;
      modelHelp.textContent = describeModel(settings.modelId);
    }

    return { root, refresh };
  }

  // ---------- upload card ----------
  let currentFile: File | null = null;
  function renderUploadSlot() {
    uploadSlot.innerHTML = '';
    if (state.file) {
      const card = el('div', { className: 'file-card' }, [
        el('img', { className: 'file-thumb', src: state.file.thumbnailUrl, alt: '' }),
        el('div', { className: 'file-meta' }, [
          el('div', { className: 'file-name' }, [state.file.name]),
          el('div', { className: 'file-sub' }, [
            `${state.file.pages} page${state.file.pages === 1 ? '' : 's'} · sending first ${Math.min(state.file.pages, settings.maxPages)}`,
          ]),
        ]),
        el('button', {
          className: 'btn-ghost',
          onclick: () => buildDropzone(true),
        }, ['Replace']),
      ]);
      uploadSlot.appendChild(card);
    } else {
      buildDropzone(false);
    }
  }

  function buildDropzone(force: boolean) {
    if (force) {
      state = { ...state, file: null };
      currentFile = null;
      reviewBtn.disabled = true;
    }
    uploadSlot.innerHTML = '';
    const input = el('input', {
      type: 'file', accept: 'application/pdf',
      onchange: (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) handleFile(f);
      },
    }) as HTMLInputElement;
    const zone = el('div', {
      className: 'dropzone',
      tabIndex: '0',
      ondragover: (e: DragEvent) => { e.preventDefault(); zone.classList.add('dragging'); },
      ondragleave: () => zone.classList.remove('dragging'),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        zone.classList.remove('dragging');
        const f = e.dataTransfer?.files?.[0];
        if (f && f.type === 'application/pdf') handleFile(f);
      },
    }, [
      el('div', { className: 'dropzone-icon' }, ['📄']),
      el('div', { className: 'dropzone-title' }, ['Drop your paper here, coward.']),
      el('div', { className: 'dropzone-sub' }, ['…or click to pick a PDF']),
      input,
    ]);
    uploadSlot.appendChild(zone);
  }

  function handleFile(f: File) {
    currentFile = f;
    reviewBtn.disabled = false;
    cbs.onPickFile(f);
  }

  function isBusy() {
    return (
      state.phase === 'loading-model' ||
      state.phase === 'rendering-pdf' ||
      state.phase === 'reviewing'
    );
  }

  // ---------- render ----------
  function render() {
    // Status bar only matters when something's happening.
    status.style.display = state.phase === 'idle' ? 'none' : '';
    statusPhase.textContent = state.phaseLabel;
    statusMeta.textContent = state.progressMeta;

    // The primary button doubles as Stop while work is in flight.
    const busy = isBusy();
    reviewBtn.textContent = busy ? 'Stop' : 'Roast it';
    reviewBtn.classList.toggle('btn-stop', busy);
    reviewBtn.disabled = busy ? false : !currentFile;
    if (state.progress === null) {
      progress.classList.add('indeterminate');
      progressBar.style.width = '30%';
    } else {
      progress.classList.remove('indeterminate');
      progressBar.style.width = `${Math.round(state.progress * 100)}%`;
    }

    // review
    if (state.reviewMarkdown.length > 0) {
      review.innerHTML = '';
      reviewBody.innerHTML = renderMarkdown(state.reviewMarkdown);
      if (state.phase === 'reviewing') {
        reviewBody.appendChild(el('span', { className: 'review-cursor' }));
      }
      review.appendChild(reviewBody);
    } else if (state.error) {
      review.innerHTML = '';
      review.appendChild(el('div', { className: 'review-empty' }, [state.error]));
    } else {
      review.innerHTML = '';
      review.appendChild(reviewEmpty);
    }

    // debug pane
    main.dataset.debug = String(settings.showDebug);
    debugBtn.setAttribute('aria-pressed', String(settings.showDebug));
    if (settings.showDebug) {
      if (!debugPane) buildDebugPane();
      if (debugPane && !debugPane.isConnected) main.appendChild(debugPane);
      renderDebug();
    } else if (debugPane && debugPane.isConnected) {
      debugPane.remove();
    }

    // upload slot
    renderUploadSlot();
  }

  function setState(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    render();
  }

  // initial render
  render();
  // url ?debug=1 force
  if (new URLSearchParams(location.search).get('debug') === '1' && !settings.showDebug) {
    settings = { ...settings, showDebug: true };
    saveSettings(settings);
    render();
  }

  return {
    root: shell,
    setState,
    getSettings: () => settings,
    el: { reviewBody },
  };
}

function describeModel(id: string): string {
  const m = findModel(id);
  return [m.note, m.sizeNote].filter(Boolean).join(' · ');
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// ---------- tiny DOM helper ----------
type Attrs = Record<string, unknown> | null;
function el(tag: string, attrs?: Attrs, children?: Array<Node | string>): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'className') node.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(node.style, v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  if (children) {
    for (const c of children) {
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return node;
}
