import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export type RenderedPdf = {
  totalPages: number;
  rendered: ImageBitmap[];
  thumbnail: ImageBitmap;
};

export async function renderPdf(
  file: File,
  maxPages: number,
  scale = 1.75,
): Promise<RenderedPdf> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const n = Math.min(maxPages, pdf.numPages);
  const rendered: ImageBitmap[] = [];
  let thumbnail: ImageBitmap | null = null;

  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(viewport.width, viewport.height)
        : (() => {
            const c = document.createElement('canvas');
            c.width = viewport.width;
            c.height = viewport.height;
            return c;
          })();
    const ctx = (canvas as OffscreenCanvas | HTMLCanvasElement).getContext('2d')!;
    await page.render({ canvasContext: ctx as CanvasRenderingContext2D, viewport }).promise;
    const bmp =
      canvas instanceof OffscreenCanvas
        ? canvas.transferToImageBitmap()
        : await createImageBitmap(canvas as HTMLCanvasElement);
    rendered.push(bmp);

    if (i === 1) {
      const thumbScale = 0.5;
      const tv = page.getViewport({ scale: thumbScale });
      const tc = document.createElement('canvas');
      tc.width = tv.width;
      tc.height = tv.height;
      await page.render({ canvasContext: tc.getContext('2d')!, viewport: tv }).promise;
      thumbnail = await createImageBitmap(tc);
    }
  }

  return {
    totalPages: pdf.numPages,
    rendered,
    thumbnail: thumbnail!,
  };
}

export function bitmapToDataUrl(bmp: ImageBitmap, maxW = 220): string {
  const scale = Math.min(1, maxW / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
