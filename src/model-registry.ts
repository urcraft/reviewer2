export type Dtype = 'q4' | 'q4f16' | 'q8' | 'fp16' | 'fp32';

export type ModelClassId =
  | 'Gemma4ForConditionalGeneration'
  | 'Lfm2VlForConditionalGeneration'
  | 'AutoModelForImageTextToText';

export type Tier = 'tiny' | 'small' | 'mid';

export type ModelEntry = {
  id: string;
  label: string;
  sizeNote: string;
  multimodal: boolean;
  modelClass: ModelClassId;
  defaultDtype: Dtype;
  tier: Tier;
  note?: string;
  // transformers.js processor only handles one image — stitch pages first.
  singleImage?: boolean;
  // Llava-family processors (LFM2-VL, Llava, Moondream) define _call(images, text)
  // — the reverse of Gemma/SmolVLM/Qwen which are _call(text, images). When true
  // the worker calls processor(images, text). The worker also catch-and-flips as a
  // safety net, since processor param names are minified in the production build.
  imagesFirst?: boolean;
};

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    label: 'Gemma 4 E2B  ·  default',
    sizeNote: '~1.5 GB · q4f16',
    multimodal: true,
    modelClass: 'Gemma4ForConditionalGeneration',
    defaultDtype: 'q4f16',
    tier: 'mid',
    note: 'Google’s smallest Gemma 4. Holds the Reviewer 2 persona and section format well. Best overall.',
  },
  {
    id: 'onnx-community/gemma-4-E4B-it-ONNX',
    label: 'Gemma 4 E4B',
    sizeNote: '~2.5 GB · q4f16',
    multimodal: true,
    modelClass: 'Gemma4ForConditionalGeneration',
    defaultDtype: 'q4f16',
    tier: 'mid',
    note: 'Bigger Gemma 4. Sharpest roasts here, longest download.',
  },
  {
    id: 'onnx-community/Qwen2-VL-2B-Instruct',
    label: 'Qwen2-VL 2B',
    sizeNote: '~2.0 GB · q4f16',
    multimodal: true,
    modelClass: 'AutoModelForImageTextToText',
    defaultDtype: 'q4f16',
    tier: 'mid',
    note: 'Strong instruction-follower. Pages are stitched into one image for this model.',
    singleImage: true,
  },
  {
    id: 'onnx-community/Phi-3.5-vision-instruct',
    label: 'Phi-3.5 Vision',
    sizeNote: '~2.5 GB · q4f16',
    multimodal: true,
    modelClass: 'AutoModelForImageTextToText',
    defaultDtype: 'q4f16',
    tier: 'mid',
    note: 'Detailed, follows structure well. Largest download.',
  },
  {
    id: 'Xenova/moondream2',
    label: 'Moondream2  ·  visual Q&A',
    sizeNote: '~1.5 GB · q4f16',
    multimodal: true,
    modelClass: 'AutoModelForImageTextToText',
    defaultDtype: 'q4f16',
    tier: 'small',
    note: 'Visual Q&A focused. Decent at description, weaker at sustained snark.',
  },
  {
    id: 'onnx-community/LFM2-VL-450M-ONNX',
    label: 'LFM2-VL 450M  ·  Liquid',
    sizeNote: '~600 MB · q4f16',
    multimodal: true,
    modelClass: 'Lfm2VlForConditionalGeneration',
    defaultDtype: 'q4f16',
    tier: 'small',
    imagesFirst: true,
    note: 'Liquid AI’s small VL model. Fast edge-inference focus; lighter than the 1B-class options.',
  },
  {
    id: 'HuggingFaceTB/SmolVLM2-500M-Video-Instruct',
    label: 'SmolVLM2 500M',
    sizeNote: '~600 MB · q4',
    multimodal: true,
    modelClass: 'AutoModelForImageTextToText',
    defaultDtype: 'q4',
    tier: 'tiny',
    note: 'Tiny & fast. Tends to summarize rather than roast — weak at holding the persona.',
  },
  {
    id: 'HuggingFaceTB/SmolVLM-256M-Instruct',
    label: 'SmolVLM 256M  ·  tiny',
    sizeNote: '~300 MB · q4',
    multimodal: true,
    modelClass: 'AutoModelForImageTextToText',
    defaultDtype: 'q4',
    tier: 'tiny',
    note: 'Smallest, runs anywhere. Mostly describes the page; don’t expect real roasting.',
  },
];

export function findModel(id: string): ModelEntry {
  return MODEL_REGISTRY.find((m) => m.id === id) ?? MODEL_REGISTRY[0];
}

const TIER_LABEL: Record<Tier, string> = {
  tiny: 'weak at the persona — mostly describes',
  small: 'okay — some snark',
  mid: 'good — holds the Reviewer 2 voice',
};

export function tierHint(entry: ModelEntry): string {
  return TIER_LABEL[entry.tier];
}
