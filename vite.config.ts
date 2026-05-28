import { defineConfig } from 'vite';

export default defineConfig({
  base: '/reviewer2/',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { target: 'esnext' },
});
