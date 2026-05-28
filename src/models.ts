import {
  AutoProcessor,
  AutoModelForImageTextToText,
  type PreTrainedModel,
  type Processor,
} from '@huggingface/transformers';

export type Dtype = 'q4' | 'q4f16' | 'q8' | 'fp16' | 'fp32';

export type ModelEntry = {
  id: string;
  label: string;
  sizeNote: string;
  multimodal: boolean;
  defaultDtype: Dtype;
  note?: string;
};

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    label: 'Gemma 4 E2B  ·  default',
    sizeNote: '~1.5 GB · q4f16',
    multimodal: true,
    defaultDtype: 'q4f16',
    note: 'Google’s smallest Gemma 4. Multimodal. Best balance of quality and size.',
  },
  {
    id: 'onnx-community/gemma-4-E4B-it-ONNX',
    label: 'Gemma 4 E4B',
    sizeNote: '~2.5 GB · q4f16',
    multimodal: true,
    defaultDtype: 'q4f16',
    note: 'Bigger Gemma 4. Sharper roasts, longer download.',
  },
  {
    id: 'HuggingFaceTB/SmolVLM-256M-Instruct',
    label: 'SmolVLM 256M  ·  tiny',
    sizeNote: '~300 MB · q4',
    multimodal: true,
    defaultDtype: 'q4',
    note: 'Fastest pick. Quality is limited — expect blunter feedback.',
  },
  {
    id: 'HuggingFaceTB/SmolVLM2-500M-Video-Instruct',
    label: 'SmolVLM2 500M',
    sizeNote: '~600 MB · q4',
    multimodal: true,
    defaultDtype: 'q4',
  },
  {
    id: 'Xenova/moondream2',
    label: 'Moondream2  ·  visual Q&A',
    sizeNote: '~1.5 GB · q4f16',
    multimodal: true,
    defaultDtype: 'q4f16',
  },
  {
    id: 'onnx-community/Qwen2-VL-2B-Instruct',
    label: 'Qwen2-VL 2B',
    sizeNote: '~2.0 GB · q4f16',
    multimodal: true,
    defaultDtype: 'q4f16',
  },
  {
    id: 'onnx-community/Phi-3.5-vision-instruct',
    label: 'Phi-3.5 Vision',
    sizeNote: '~2.5 GB · q4f16',
    multimodal: true,
    defaultDtype: 'q4f16',
  },
];

export function findModel(id: string): ModelEntry {
  return MODEL_REGISTRY.find((m) => m.id === id) ?? MODEL_REGISTRY[0];
}

export type LoadedModel = {
  entry: ModelEntry;
  processor: Processor;
  model: PreTrainedModel;
};

export type ProgressInfo = {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
};

export async function loadModel(
  entry: ModelEntry,
  dtype: Dtype,
  onProgress: (info: ProgressInfo) => void,
): Promise<LoadedModel> {
  const processor = (await AutoProcessor.from_pretrained(entry.id, {
    progress_callback: onProgress as never,
  })) as unknown as Processor;

  const model = (await AutoModelForImageTextToText.from_pretrained(entry.id, {
    dtype,
    device: 'webgpu',
    progress_callback: onProgress as never,
  })) as unknown as PreTrainedModel;

  return { entry, processor, model };
}
