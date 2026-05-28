import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();

  const workerUrls: string[] = [];
  page.on('worker', (w) => workerUrls.push(w.url().split('/').pop() ?? ''));

  await page.goto('http://127.0.0.1:4173/reviewer2/?debug=1', { waitUntil: 'networkidle' });
  await page.waitForSelector('.brand-mark');
  await page.waitForTimeout(500);
  const initialInferenceWorkers = workerUrls.filter((u) => u.startsWith('worker-')).length;
  console.log('after initial load — inference workers spawned:', initialInferenceWorkers, '(expected: 1)');

  // Trigger the "Clear cached models" path which we wired to resetWorker().
  await page.click('button[title="Settings"]');
  await page.waitForSelector('.drawer.open');
  const before = workerUrls.length;
  await page.click('button:has-text("Clear cached models")');
  await page.waitForTimeout(800);
  const afterReset = workerUrls.filter((u) => u.startsWith('worker-')).length;
  console.log('inference workers spawned after Clear cached:', afterReset, '(expected: 2)');
  console.log('all worker URLs:', workerUrls);

  // Check the event log mentions the reset.
  await page.click('.scrim');
  await page.click('button[title="Toggle debug pane"]').catch(() => {});
  const events = (await page.locator('.debug-content').textContent()) ?? '';
  const sawResetLog = events.includes('worker reset (cache cleared)');
  console.log('event log shows reset:', sawResetLog);

  await browser.close();
  console.log(initialInferenceWorkers === 1 && afterReset === 2 && sawResetLog ? 'PASS' : 'FAIL');
})().catch((e) => { console.error(e); process.exit(1); });
