import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE);
  await page.waitForSelector('math-field');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('math-field');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const items = await page.evaluate(() => [...document.querySelectorAll('#palette-grid .palette-btn')].map(b=>b.textContent));
  console.log('palette items', items);
  const idx = items.indexOf('∞');
  console.log('infty index', idx);
  if (idx >= 0) {
    await page.click(`#palette-grid .palette-btn:nth-child(${idx+1})`);
    console.log('after infty click', await page.evaluate(() => window.__neoApp.getActiveRow().mf.value));
  }
  const idxTo = items.indexOf('→');
  console.log('to index', idxTo);
  await browser.close();
}
main();
