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
  async function state() { return page.evaluate(() => { const r=window.__neoApp.getActiveRow(); return { latex: r.mf.value, depth: r.stack.length, kinds: r.stack.map(x=>x.kind) }; }); }
  async function reset() { await page.evaluate(() => { const r=window.__neoApp.getActiveRow(); r.mf.value=''; r.mf.position=0; r.stack=[]; r.run=[]; r.runStack=[]; r.history=[]; r.mf.focus(); }); await page.waitForTimeout(30); }

  console.log('== nesting ==');
  await reset();
  await dispatch({type:'open',kind:'paren'});
  console.log('after paren', await state());
  await dispatch({type:'nfrac'});
  console.log('after nfrac inside paren', await state());
  await press('Digit1'); await press('Enter'); await press('Digit2');
  console.log('mid nest', await state());
  await press('Enter');
  console.log('after 1 enter (close frac)', await state());
  await press('Enter');
  console.log('after 2 enter (close paren)', await state());
  await press('Space');
  console.log('after space', await state());

  console.log('== reopen ==');
  await reset();
  await dispatch({type:'open',kind:'sqrt'});
  await press('Digit4');
  console.log('sqrt(4 open', await state());
  await press('Enter');
  console.log('closed', await state());
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await page.waitForTimeout(15);
  console.log('shift+enter reopen', await state());

  console.log('== previous-term patterns ==');
  await reset();
  await dispatch({type:'open',kind:'paren'});
  await press('Digit1'); await dispatch({type:'op', symbol:'+'});
  console.log('after paren 1 + (checking op dispatch)', await state());
  await browser.close();
}
main();
