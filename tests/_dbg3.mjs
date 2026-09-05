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

  console.log('pattern1: closed group');
  await reset();
  await dispatch({type:'open',kind:'paren'});
  await press('Digit1'); await dispatch({type:'op',symbol:'+'}); await press('Digit2'); await press('Enter');
  await dispatch({type:'afrac'});
  await press('Digit9'); await press('Enter');
  console.log(await latex());

  console.log('pattern2: digit run');
  await reset();
  await press('Digit1'); await press('Digit2'); await press('Digit3');
  await dispatch({type:'afrac'});
  await press('Digit4'); await press('Enter');
  console.log(await latex());

  console.log('pattern3: var+script');
  await reset();
  await typeLiteral('a');
  await dispatch({type:'open',kind:'sub'});
  await typeLiteral('n'); await press('Enter');
  await dispatch({type:'afrac'});
  await typeLiteral('m'); await press('Enter');
  console.log(await latex());

  console.log('pattern4: func app sin x');
  await reset();
  await dispatch({type:'func', name:'sin'});
  await typeLiteral('x');
  await dispatch({type:'afrac'});
  await press('Digit2'); await press('Enter');
  console.log(await latex());

  console.log('boundary: 1+23');
  await reset();
  await press('Digit1'); await dispatch({type:'op',symbol:'+'}); await press('Digit2'); await press('Digit3');
  await dispatch({type:'afrac'});
  await press('Digit9'); await press('Enter');
  console.log(await latex());

  await browser.close();
}
main();
