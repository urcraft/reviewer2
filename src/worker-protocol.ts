import type { Dtype } from './model-registry';

export type Device = 'webgpu' | 'wasm';

export type PageImage = {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
};

// Main -> Worker
export type LoadRequest = {
  type: 'load';
  modelId: string;
  dtype: Dtype;
  device: Device;
};

export type GenerateRequest = {
  type: 'generate';
  images: PageImage[];
  systemPrompt: string;
  userPrompt: string;
  maxNewTokens: number;
};

export type InterruptRequest = { type: 'interrupt' };

export type WorkerRequest = LoadRequest | GenerateRequest | InterruptRequest;

// Worker -> Main
export type ProgressMsg = {
  type: 'progress';
  file: string;
  loaded: number;
  total: number;
};
export type LogMsg = { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
export type LoadedMsg = { type: 'loaded' };
export type LoadErrorMsg = { type: 'loadError'; message: string; isWebGpu: boolean };
export type TokenMsg = { type: 'token'; text: string };
export type GeneratedMsg = {
  type: 'generated';
  tokens: number;
  elapsedMs: number;
  interrupted: boolean;
};
export type GenerateErrorMsg = { type: 'generateError'; message: string; isWebGpu: boolean };

export type WorkerResponse =
  | ProgressMsg
  | LogMsg
  | LoadedMsg
  | LoadErrorMsg
  | TokenMsg
  | GeneratedMsg
  | GenerateErrorMsg;
