import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const conLogs: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('CERT_AUTHORITY')) {
      conLogs.push('[ERR] ' + t);
    } else if (m.type() === 'warning') {
      conLogs.push('[warn] ' + t);
    }
  });
  page.on('requestfailed', (r) => conLogs.push(`[404?] ${r.url()} :: ${r.failure()?.errorText ?? ''}`));

  await page.goto('http://127.0.0.1:4173/reviewer2/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const headerVisible = await page.locator('.brand-mark').count();
  const dropzoneVisible = await page.locator('.dropzone').count();
  console.log('header visible:', headerVisible, '· dropzone visible:', dropzoneVisible);
  console.log('--- pageerror ---');
  errors.forEach((e) => console.log(e));
  console.log('--- console ---');
  conLogs.forEach((e) => console.log(e));

  await page.screenshot({ path: 'screens/10-preview-prod-build.png', fullPage: false });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
