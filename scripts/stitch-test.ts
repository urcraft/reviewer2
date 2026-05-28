import { chromium } from 'playwright';

async function run(modelId: string, label: string) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 820 } });
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:4173/reviewer2/?debug=1', { waitUntil: 'networkidle' });
  await p.waitForSelector('.brand-mark');
  await p.selectOption('.pill-select', modelId);
  const input = await p.waitForSelector('.dropzone input[type="file"]');
  await input.setInputFiles('/tmp/sample2.pdf');
  await p.waitForTimeout(1500);
  await p.click('button.debug-tab:has-text("Events")').catch(() => {});
  const events = (await p.locator('.debug-content').textContent()) ?? '';
  console.log(
    `${label}: rendered2pages=${events.includes('rendered 2')} stitched=${events.includes('stitched into 1 image')}`,
  );
  await b.close();
}

await run('onnx-community/Qwen2-VL-2B-Instruct', 'Qwen2-VL (expect stitched=true)');
await run('onnx-community/gemma-4-E2B-it-ONNX', 'Gemma4   (expect stitched=false)');
