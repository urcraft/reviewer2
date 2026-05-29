import { MODEL_REGISTRY, type Dtype } from './model-registry';
import { DEFAULT_PROMPT_VARIANT_ID } from './prompts';

const KEY = 'reviewer2.settings.v1';

export type Device = 'auto' | 'webgpu' | 'wasm';

export type Provider = 'local' | 'openrouter';

export type Settings = {
  provider: Provider;
  modelId: string;
  // OpenRouter (cloud) settings. The key lives only in this browser's localStorage.
  openrouterApiKey: string;
  openrouterModelId: string;
  maxPages: number;
  // Which Reviewer 2 persona to use — see PROMPT_VARIANTS in prompts.ts.
  promptVariant: string;
  dtype: Dtype | 'default';
  device: Device;
  showDebug: boolean;
  // False until the first-run modal has been seen/dismissed.
  onboarded: boolean;
};

const DEFAULTS: Settings = {
  provider: 'local',
  modelId: MODEL_REGISTRY[0].id,
  openrouterApiKey: '',
  openrouterModelId: 'openrouter/free',
  maxPages: 3,
  promptVariant: DEFAULT_PROMPT_VARIANT_ID,
  dtype: 'default',
  device: 'auto',
  showDebug: false,
  onboarded: false,
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
