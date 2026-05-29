import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageImage } from './worker-protocol';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export type RenderedPdf = {
  totalPages: number;
  pages: PageImage[];
  thumbnailUrl: string;
};

export async function renderPdf(
  file: File,
  maxPages: number,
  scale = 1.75,
): Promise<RenderedPdf> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const n = Math.min(maxPages, pdf.numPages);
  const pages: PageImage[] = [];
  let thumbnailUrl = '';

  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = new OffscreenCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pages.push({ data: imageData.data, width: canvas.width, height: canvas.height });

    if (i === 1) {
      const thumbScale = 0.5;
      const tv = page.getViewport({ scale: thumbScale });
      const tc = document.createElement('canvas');
      tc.width = tv.width;
      tc.height = tv.height;
      await page.render({ canvasContext: tc.getContext('2d')!, viewport: tv }).promise;
      thumbnailUrl = tc.toDataURL('image/png');
    }
  }

  return { totalPages: pdf.numPages, pages, thumbnailUrl };
}

// Encode a rendered page (RGBA buffer) as a base64 JPEG data URL for OpenRouter's
// `image_url` content parts. JPEG keeps the request payload small; quality 0.8 is
// plenty for text-heavy pages. A copy is taken because ImageData needs a backing
// buffer it owns.
export function pageImageToDataUrl(p: PageImage, quality = 0.8): string {
  const canvas = document.createElement('canvas');
  canvas.width = p.width;
  canvas.height = p.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  return canvas.toDataURL('image/jpeg', quality);
}

// Some VLM processors in transformers.js only handle a single image — passing
// N pages makes their image-grid math non-integer. For those models (flagged
// singleImage in the registry) we stitch the pages into one tall image with
// white separators.
// maxPixels caps the stitched image so a tall multi-page composite doesn't
// blow up the vision encoder's activation memory (a common WebGPU OOM cause).
export function stitchPages(pages: PageImage[], gap = 16, maxPixels = 2_000_000): PageImage {
  if (pages.length === 1) return pages[0];
  const width = Math.max(...pages.map((p) => p.width));
  const height = pages.reduce((h, p) => h + p.height, 0) + gap * (pages.length - 1);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  for (const p of pages) {
    const copy = new Uint8ClampedArray(p.data);
    ctx.putImageData(new ImageData(copy, p.width, p.height), 0, y);
    y += p.height + gap;
  }

  const px = width * height;
  if (px <= maxPixels) {
    const merged = ctx.getImageData(0, 0, width, height);
    return { data: merged.data, width, height };
  }

  const s = Math.sqrt(maxPixels / px);
  const ow = Math.max(1, Math.round(width * s));
  const oh = Math.max(1, Math.round(height * s));
  const small = new OffscreenCanvas(ow, oh);
  const sctx = small.getContext('2d')!;
  sctx.drawImage(canvas, 0, 0, ow, oh);
  const merged = sctx.getImageData(0, 0, ow, oh);
  return { data: merged.data, width: ow, height: oh };
}

