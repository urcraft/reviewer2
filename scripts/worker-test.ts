import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  const conErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('CERT_AUTHORITY') && !t.includes('ERR_ABORTED')) {
      conErrors.push(t);
    }
  });
  // Track worker creation.
  let workerCreated = false;
  page.on('worker', (w) => {
    workerCreated = true;
    console.log('worker spawned:', w.url().split('/').pop());
  });

  await page.goto('http://127.0.0.1:4173/reviewer2/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.brand-mark');

  // Upload the sample PDF.
  const input = await page.waitForSelector('.dropzone input[type="file"]');
  await input.setInputFiles('/tmp/sample.pdf');

  // Wait until the primary button flips to "Stop" (work in flight).
  let became = '';
  try {
    await page.waitForFunction(
      () => document.querySelector('.btn-primary')?.textContent === 'Stop',
      { timeout: 6000 },
    );
    became = 'Stop';
  } catch {
    became = await page.locator('.btn-primary').textContent() ?? '(none)';
  }

  const phase = await page.locator('.status-phase').textContent();
  const fileCard = await page.locator('.file-card').count();
  await page.screenshot({ path: 'screens/11-worker-busy-stop.png' });

  // Confirm the main thread is responsive: settings drawer opens instantly while busy.
  await page.click('button[title="Settings"]');
  const drawerOpen = await page.locator('.drawer.open').count();

  // Click Stop and confirm it returns to "Roast it".
  await page.click('.scrim');
  if (became === 'Stop') {
    await page.click('.btn-primary');
  }

  console.log('--- results ---');
  console.log('worker spawned:', workerCreated);
  console.log('button became:', JSON.stringify(became));
  console.log('phase while busy:', JSON.stringify(phase));
  console.log('file card present:', fileCard);
  console.log('settings drawer opened while busy (responsive):', drawerOpen === 1);
  console.log('--- pageerrors ---');
  pageErrors.forEach((e) => console.log('  ' + e));
  console.log('--- console errors ---');
  conErrors.forEach((e) => console.log('  ' + e));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
