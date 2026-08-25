import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  row.mf.value = 'a \equiv b ';
  row.mf.executeCommand(['insert', '\pmod{n}', { insertionMode: 'insertAfter', format: 'latex' }]);
});
await page.locator('.row math-field').first().screenshot({ path: 'tests/out-verify-mod.png' });
const val = await page.evaluate(() => window.__neoApp.getActiveRow().mf.value);
console.log(val);
await browser.close();
