import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await page.goto(BASE);
  await page.waitForSelector('math-field');
  await page.waitForTimeout(200);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('math-field');
  await page.click('math-field');
  async function press(c) { await page.keyboard.press(c); await page.waitForTimeout(15); }
  async function type(word) { for (const ch of word) await press(`Key${ch.toUpperCase()}`); }
  async function latex() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
  async function reset() {
    await page.evaluate(() => {
      const row = window.__neoApp.getActiveRow();
      row.mf.value = ''; row.mf.position = 0; row.stack = []; row.run = []; row.runStack = []; row.history = [];
      row.mf.focus();
    });
    await page.waitForTimeout(30);
  }

  await reset();
  await press('Digit3');
  await type('division'); await press('Enter');
  console.log('3 division ->', await latex());

  await reset();
  await type('power'); await press('Enter');
  console.log('power ->', await latex());

  await reset();
  await type('subscript'); await press('Enter');
  console.log('subscript ->', await latex());

  await reset();
  await type('sqrt'); await press('Enter');
  console.log('sqrt ->', await latex());

  await reset();
  await type('absolute'); await press('Enter');
  console.log('absolute ->', await latex());

  await reset();
  await type('sum'); await press('Enter');
  console.log('sum ->', await latex());

  await reset();
  await type('limit'); await press('Enter');
  console.log('limit ->', await latex());

  await browser.close();
}
main();
