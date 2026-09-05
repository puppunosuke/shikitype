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
  async function latex() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
  async function insertRaw(l) { await page.evaluate((latex) => { const row = window.__neoApp.getActiveRow(); row.mf.executeCommand(['insert', latex, { insertionMode: 'insertAfter', format: 'latex' }]); }, l); }
  await insertRaw('\infty ');
  console.log('infty alone raw', await latex());
  await insertRaw('\to ');
  console.log('+ to raw', await latex());
  await insertRaw('\rightarrow ');
  console.log('+ rightarrow raw', await latex());
  await browser.close();
}
main();
