import { MODEL_REGISTRY, type Dtype } from './models';

const KEY = 'reviewer2.settings.v1';

export type Settings = {
  modelId: string;
  maxPages: number;
  dtype: Dtype | 'default';
  showDebug: boolean;
};

const DEFAULTS: Settings = {
  modelId: MODEL_REGISTRY[0].id,
  maxPages: 3,
  dtype: 'default',
  showDebug: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota / privacy mode — ignore */
  }
}
