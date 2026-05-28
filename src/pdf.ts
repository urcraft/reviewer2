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
