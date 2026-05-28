import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('CERT_AUTHORITY')) {
      consoleErrors.push(m.text());
    }
  });

  await page.goto('http://127.0.0.1:5173/reviewer2/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.brand-mark');

  // Upload a PDF.
  const input = await page.waitForSelector('.dropzone input[type="file"]');
  await input.setInputFiles('/tmp/sample.pdf');

  // Wait for either the model-load state or an error.
  await page.waitForFunction(
    () => {
      const phase = document.querySelector('.status-phase')?.textContent ?? '';
      return phase.length > 0 && phase !== 'Drop a PDF to begin.';
    },
    { timeout: 4000 },
  ).catch(() => {});

  await page.waitForTimeout(800);

  // Open debug pane so we can capture the event log.
  await page.click('button[title="Toggle debug pane"]');
  await page.waitForSelector('.debug');

  // Switch to the events tab.
  await page.click('button.debug-tab:has-text("Events")');
  await page.waitForTimeout(300);

  await page.screenshot({ path: 'screens/09-uploaded-events.png', fullPage: false });

  // Read status + event log text to verify what fired.
  const status = await page.locator('.status-phase').textContent();
  const events = await page.locator('.debug-content').textContent();
  const fileCardVisible = await page.locator('.file-card').count();

  console.log('---');
  console.log('phase label:', JSON.stringify(status));
  console.log('file card present:', fileCardVisible);
  console.log('events:\n' + (events ?? '(none)'));
  console.log('---');
  if (errors.length) console.log('PAGE ERRORS:', errors);
  if (consoleErrors.length) console.log('CONSOLE ERRORS:', consoleErrors);

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
