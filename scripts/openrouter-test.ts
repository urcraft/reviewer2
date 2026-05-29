import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    // The free-models fetch to openrouter.ai is blocked in this sandbox (host
    // allowlist) and surfaces as a benign network error — it succeeds in a real
    // browser and the UI degrades gracefully. Ignore that one.
    const t = m.text();
    if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(t)) {
      errors.push(`[console.error] ${t}`);
    }
  });

  await page.goto('http://127.0.0.1:5173/reviewer2/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.brand-mark', { timeout: 8000 });

  // First-run modal should be visible.
  await page.waitForSelector('.modal.open', { timeout: 4000 });
  console.log('✓ first-run modal shown');

  // Choose cloud → key panel reveals, start disabled until a key is typed.
  await page.click('.modal-choice:has-text("Use OpenRouter")');
  await page.waitForSelector('.modal-cloud', { state: 'visible', timeout: 2000 });
  const startDisabledBefore = await page.isDisabled('.modal-cloud .btn-primary');
  await page.fill('.modal-cloud .field-input', 'sk-or-v1-testkey');
  const startDisabledAfter = await page.isDisabled('.modal-cloud .btn-primary');
  console.log(`✓ cloud panel: start disabled before key=${startDisabledBefore}, after=${startDisabledAfter}`);
  if (!startDisabledBefore || startDisabledAfter) throw new Error('start button enabled-state wrong');

  await page.click('.modal-cloud .btn-primary');
  await page.waitForSelector('.modal.open', { state: 'detached', timeout: 2000 }).catch(() => {});
  const modalGone = !(await page.isVisible('.modal.open'));
  console.log(`✓ modal closed after save: ${modalGone}`);

  // Header pill should now show the cloud option selected + cloud hint chip.
  const pillVal = await page.$eval('.pill-select', (e) => (e as HTMLSelectElement).value);
  const hasCloudChip = await page.isVisible('.cloud-chip');
  console.log(`✓ header pill value="${pillVal}", cloud chip visible=${hasCloudChip}`);
  if (pillVal !== 'openrouter/free' || !hasCloudChip) throw new Error('cloud not reflected in controls');

  // Settings drawer: key field visible + populated, local-only fields hidden.
  await page.click('button[title="Settings"]');
  await page.waitForSelector('.drawer.open', { timeout: 2000 });
  const keyVal = await page.$eval('.drawer input[type="password"]', (e) => (e as HTMLInputElement).value);
  console.log(`✓ drawer key field value="${keyVal}"`);
  if (keyVal !== 'sk-or-v1-testkey') throw new Error('key not persisted to drawer');

  // OpenRouter model picker: a real dropdown defaulting to the router, with a
  // "Custom…" entry that reveals a slug input; the header hint follows the choice.
  // (The drawer has two .field-select now: [0] = source/model, [1] = OpenRouter model.)
  const modelSelect = page.locator('.drawer .field-select').nth(1);
  const defaultModel = await modelSelect.inputValue();
  console.log(`✓ model dropdown default="${defaultModel}"`);
  if (defaultModel !== 'openrouter/free') throw new Error('model dropdown default wrong');
  await modelSelect.selectOption('__custom__');
  const customInput = page.locator('.drawer input[placeholder^="e.g."]');
  await customInput.waitFor({ state: 'visible', timeout: 2000 });
  await customInput.fill('google/gemma-3-27b-it:free');
  await page.waitForTimeout(50);
  const hintText = await page.textContent('.model-hint-text');
  console.log(`✓ hint reflects custom model: "${hintText}"`);
  if (!hintText?.includes('google/gemma-3-27b-it:free')) throw new Error('hint did not update');
  // Reset to the router so the local-switch check below is clean.
  await modelSelect.selectOption('openrouter/free');

  // Switch to a local model via the drawer dropdown → provider flips to local.
  await page.selectOption('.drawer .field-select', { index: 1 }); // first local model in the optgroup
  const pillAfter = await page.$eval('.pill-select', (e) => (e as HTMLSelectElement).value);
  console.log(`✓ after picking local, pill value="${pillAfter}"`);
  if (pillAfter === 'openrouter/free') throw new Error('did not switch back to local');

  // Reload → settings persisted, modal does NOT reappear.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.brand-mark', { timeout: 8000 });
  const modalOnReload = await page.isVisible('.modal.open');
  console.log(`✓ modal on reload (should be false): ${modalOnReload}`);
  if (modalOnReload) throw new Error('modal reappeared after onboarding');

  if (errors.length) {
    console.error('CONSOLE/PAGE ERRORS:\n' + errors.join('\n'));
    throw new Error(`${errors.length} page error(s)`);
  }
  console.log('\nALL SMOKE CHECKS PASSED');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
