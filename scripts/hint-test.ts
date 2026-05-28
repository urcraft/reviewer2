import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto('http://127.0.0.1:4173/reviewer2/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.model-hint');

  const chip = await page.locator('.tier-chip').textContent();
  const hint = await page.locator('.model-hint-text').textContent();
  console.log('default chip:', JSON.stringify(chip), '| hint:', JSON.stringify(hint));

  // Switch to SmolVLM 256M (tiny) and confirm the chip turns "tiny".
  await page.selectOption('.pill-select', 'HuggingFaceTB/SmolVLM-256M-Instruct');
  const chip2 = await page.locator('.tier-chip').textContent();
  const hint2 = await page.locator('.model-hint-text').textContent();
  console.log('tiny chip:', JSON.stringify(chip2), '| hint:', JSON.stringify(hint2));

  await page.screenshot({ path: 'screens/12-model-hint.png' });
  console.log('pageerrors:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
