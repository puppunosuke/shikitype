import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  row.mf.executeCommand(['insert', 'a\equiv b', { insertionMode: 'insertAfter', format: 'latex' }]);
  row.mf.executeCommand(['insert', '\pmod{n}', { insertionMode: 'insertAfter', format: 'latex' }]);
});
const val = await page.evaluate(() => window.__neoApp.getActiveRow().mf.value);
console.log('latex:', val);
await page.locator('.row math-field').first().screenshot({ path: 'tests/out-verify-mod3.png' });
await browser.close();
