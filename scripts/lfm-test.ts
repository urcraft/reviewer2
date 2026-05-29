import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:4173/reviewer2/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.model-hint');

  const options = await page.locator('.pill-select option').allTextContents();
  console.log('options:');
  options.forEach((o) => console.log('  -', o));

  await page.selectOption('.pill-select', 'onnx-community/LFM2-VL-450M-ONNX');
  await page.waitForTimeout(200);
  const hint = await page.locator('.model-hint').textContent();
  console.log('LFM2-VL-450M hint:', JSON.stringify(hint));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
