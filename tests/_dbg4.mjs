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

  console.log('== letters lower/upper via literal typing ==');
  for (const L of ['A','F','J','M','Q','V','Z']) {
    await reset();
    await press('Key'+L); await press('Enter');
    console.log(L, 'lower', await latex());
    await reset();
    await page.keyboard.down('Shift'); await press('Key'+L); await page.keyboard.up('Shift'); await press('Enter');
    console.log(L, 'upper', await latex());
  }

  console.log('== greek layer via Tab ==');
  await reset();
  await press('Tab'); // symbol -> greek?
  console.log('layer after 1 tab', await page.evaluate(() => window.__neoApp.getBaseLayer()));
  await press('KeyA');
  await page.keyboard.down('Shift'); await press('KeyG'); await page.keyboard.up('Shift');
  console.log('greek a + Shift+G', await latex());
  await press('Tab'); // back to symbol
  console.log('layer after 2nd tab', await page.evaluate(() => window.__neoApp.getBaseLayer()));

  console.log('== lim n->infty ==');
  await reset();
  await dispatch({type:'lim'});
  await typeLiteral('n');
  await dispatch({type:'op', symbol:'\to '});
  await dispatch({type:'op', symbol:'\infty '});
  await press('Enter');
  console.log(await latex());

  console.log('== sum k=1 -> n ==');
  await reset();
  await dispatch({type:'sum'});
  await typeLiteral('k'); await dispatch({type:'op',symbol:'='}); await press('Digit1'); await press('Enter');
  await typeLiteral('n'); await press('Enter');
  console.log(await latex());

  await browser.close();
}
main();
