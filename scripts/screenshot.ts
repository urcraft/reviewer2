import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('screens', { recursive: true });

async function shoot(label: string, mode: 'dark' | 'light', viewport: { width: number; height: number }, ops: (page: import('playwright').Page) => Promise<void>) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport,
    colorScheme: mode,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', label, e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[console.error]', label, m.text());
  });
  await page.goto('http://127.0.0.1:5173/reviewer2/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.brand-mark', { timeout: 8000 });
  await ops(page);
  await page.screenshot({ path: `screens/${label}.png`, fullPage: false });
  console.log(`  ✓ ${label}`);
  await browser.close();
}

(async () => {
  // 1. Desktop dark — initial empty state
  await shoot('01-desktop-dark-empty', 'dark', { width: 1280, height: 820 }, async () => {
    // nothing
  });

  // 2. Desktop light
  await shoot('02-desktop-light-empty', 'light', { width: 1280, height: 820 }, async () => {});

  // 3. Desktop dark — dragging state (simulated)
  await shoot('03-desktop-dark-dragging', 'dark', { width: 1280, height: 820 }, async (page) => {
    await page.evaluate(() => {
      document.querySelector('.dropzone')?.classList.add('dragging');
    });
  });

  // 4. Desktop dark — with debug pane open
  await shoot('04-desktop-dark-debug-open', 'dark', { width: 1440, height: 900 }, async (page) => {
    await page.click('button[title="Toggle debug pane"]');
    await page.waitForSelector('.debug', { timeout: 4000 });
  });

  // 5. Desktop dark — settings drawer
  await shoot('05-desktop-dark-settings', 'dark', { width: 1280, height: 820 }, async (page) => {
    await page.click('button[title="Settings"]');
    await page.waitForSelector('.drawer.open', { timeout: 4000 });
  });

  // 6. Mobile dark — empty
  await shoot('06-mobile-dark-empty', 'dark', { width: 390, height: 800 }, async () => {});

  const SAMPLE_MD = `## Summary
The authors propose yet another attention variant that — they claim — improves throughput by 3% on a benchmark of their own choosing. Bold of them to call it a "breakthrough."

## Strengths (Grudging)
- The figures are at least readable.
- The math notation is, technically, consistent.

## Weaknesses
- **Novelty:** The proposed mechanism is a rebranding of FlashAttention-2 with a single hyperparameter renamed. The authors do not cite the original work in the abstract.
- **Methodology:** Three random seeds. *Three.* No confidence intervals on any reported number. The ablation in Table 2 omits the obvious baseline.
- **Related Work:** A two-paragraph section that manages to ignore both Dao et al. (2022) and Shazeer (2019). Did the authors discover BibTeX yesterday?
- **Rigor:** Claims of "state-of-the-art" rest on a 0.4 BLEU improvement that falls comfortably inside any reasonable variance band.
- **Writing:** Section 4 is a wall of equations with no accompanying intuition. The reader is, charitably, abandoned.

## Detailed Comments
The introduction claims this is the first work to *"address the quadratic bottleneck."* It is not. Page 5, line 12: the kernel formulation contains a typo that, if taken literally, would crash any GPU.

## Recommendation
**REJECT** — Resubmit when there are at least five seeds, a real related-work section, and a measure of self-awareness.`;

  // Inject sample markdown via the app's own module graph by importing the module URL Vite serves.
  async function injectSampleReview(page: import('playwright').Page, md: string) {
    await page.evaluate((sampleMd) => {
      const w = window as unknown as { __r2: { renderMarkdown: (s: string) => string; debugBus: { info: (m: string) => void; appendRaw: (s: string) => void } } };
      const review = document.querySelector('.review');
      if (!review || !w.__r2) return;
      review.innerHTML = '<div class="review-body"></div>';
      const body = review.querySelector('.review-body') as HTMLElement;
      body.innerHTML = w.__r2.renderMarkdown(sampleMd);
    }, md);
  }

  // Expose the app's modules on window for screenshot tests.
  async function exposeModules(page: import('playwright').Page) {
    await page.addScriptTag({
      type: 'module',
      content: `
        import { renderMarkdown } from '/reviewer2/src/markdown.ts';
        import { debugBus } from '/reviewer2/src/debug.ts';
        window.__r2 = { renderMarkdown, debugBus };
      `,
    });
    await page.waitForFunction(() => Boolean((window as unknown as { __r2?: unknown }).__r2));
  }

  // 7. Desktop dark — review pane populated with sample markdown
  await shoot('07-desktop-dark-review-rendered', 'dark', { width: 1280, height: 1040 }, async (page) => {
    await exposeModules(page);
    await injectSampleReview(page, SAMPLE_MD);
    await page.waitForTimeout(200);
  });

  // 8. Desktop dark — review + debug pane (with raw output populated)
  await shoot('08-desktop-dark-review-debug', 'dark', { width: 1440, height: 1040 }, async (page) => {
    await exposeModules(page);
    await page.click('button[title="Toggle debug pane"]');
    await page.waitForSelector('.debug', { timeout: 4000 });
    await injectSampleReview(page, SAMPLE_MD);
    await page.evaluate((md) => {
      const w = window as unknown as { __r2: { debugBus: { info: (m: string) => void; appendRaw: (s: string) => void } } };
      w.__r2.debugBus.info('model: loading onnx-community/gemma-4-E2B-it-ONNX (dtype q4f16, device webgpu)');
      w.__r2.debugBus.info('download: starting model.onnx_data');
      w.__r2.debugBus.info('download: model.onnx_data');
      w.__r2.debugBus.info('pdf: 8 total page(s), rendered 3');
      w.__r2.debugBus.info('processor: encoding 3 image(s) + prompt');
      w.__r2.debugBus.info('generate: starting');
      w.__r2.debugBus.appendRaw(md);
      w.__r2.debugBus.info('generate: done · 142 tokens · 8.4s · 16.9 tok/s');
    }, SAMPLE_MD);
    await page.waitForTimeout(400);
  });

  console.log('All screenshots written to ./screens/');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
