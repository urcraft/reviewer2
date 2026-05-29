import { filterFreeVisionModels } from '../src/openrouter';

// Sample shaped like OpenRouter's /models response, including the false positives
// the old filter let through.
const sample = [
  // ✓ free, image in, text out (new-style modalities)
  { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
  // ✓ free, image in, text out (legacy modality string only)
  { id: 'qwen/qwen2.5-vl-72b-instruct:free', name: 'Qwen2.5-VL 72B', architecture: { modality: 'text+image->text' } },
  // ✗ Lyria: not :free, image in but AUDIO out, token prices read 0
  { id: 'google/lyria', name: 'Lyria', architecture: { input_modalities: ['text', 'image'], output_modalities: ['audio'] }, pricing: { prompt: '0', completion: '0' } },
  // ✗ free but text-only input (can't read the page images)
  { id: 'meta/llama-3.1-8b:free', name: 'Llama 3.1 8B', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  // ✗ free image-IN but image-OUT (image generation, not a reviewer)
  { id: 'someorg/image-gen:free', name: 'ImgGen', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } },
  // ✗ paid vision model (no :free suffix)
  { id: 'openai/gpt-4o', name: 'GPT-4o', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
];

const got = filterFreeVisionModels(sample).map((m) => m.id);
const want = ['google/gemma-3-27b-it:free', 'qwen/qwen2.5-vl-72b-instruct:free'];

const ok = got.length === want.length && want.every((id, i) => got[i] === id);
console.log('kept:', got);
if (!ok) {
  console.error('FAIL — expected', want, 'got', got);
  process.exit(1);
}
if (got.includes('google/lyria')) {
  console.error('FAIL — Lyria (audio model) was not filtered out');
  process.exit(1);
}
console.log('PASS — free image→text models only; Lyria and friends excluded');
