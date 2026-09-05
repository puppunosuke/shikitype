import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await page.goto(BASE);
  await page.waitForSelector('math-field');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('math-field');
  async function press(c) { await page.keyboard.press(c); await page.waitForTimeout(15); }
  async function dispatch(a) { await page.evaluate((act) => { window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), act); }, a); await page.waitForTimeout(15); }
  async function typeLiteral(s) { for (const ch of s) { await press('Key'+ch.toUpperCase()); await press('Enter'); } }
  async function latex() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
  async function reset() { await page.evaluate(() => { const r=window.__neoApp.getActiveRow(); r.mf.value=''; r.mf.position=0; r.stack=[]; r.run=[]; r.runStack=[]; r.history=[]; r.mf.focus(); }); await page.waitForTimeout(30); }

  await reset();
  await dispatch({type:'open',kind:'paren'});
  await press('Digit1'); await press('Enter');
  console.log('paren(1)', await latex());

  await reset();
  await dispatch({type:'nfrac'});
  await press('Digit1'); await press('Enter');
  await press('Digit2'); await press('Enter');
  console.log('nfrac 1/2', await latex());

  await reset();
  await press('Digit3');
  await dispatch({type:'afrac'});
  await press('Digit4'); await press('Enter');
  console.log('afrac 3/4', await latex());

  await reset();
  await typeLiteral('x');
  await dispatch({type:'open',kind:'sup'});
  await press('Digit2'); await press('Enter');
  console.log('x^2', await latex());

  await reset();
  await typeLiteral('x');
  await dispatch({type:'open',kind:'sub'});
  await press('Digit1'); await press('Enter');
  console.log('x_1', await latex());

  await reset();
  await dispatch({type:'open',kind:'sqrt'});
  await press('Digit9'); await press('Enter');
  console.log('sqrt9', await latex());

  await reset();
  await dispatch({type:'open',kind:'abs'});
  await press('Minus'); await press('Digit5'); await press('Enter');
  console.log('abs -5 (via Minus key)', await latex());

  await browser.close();
}
main();
