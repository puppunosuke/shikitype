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

  console.log('== lim n->infty fresh ==');
  await dispatch({type:'lim'});
  console.log('after lim', await latex());
  await typeLiteral('n');
  console.log('after n', await latex());
  await dispatch({type:'op', symbol:'\to '});
  console.log('after to', await latex());
  await dispatch({type:'op', symbol:'\infty '});
  console.log('after infty', await latex());
  await press('Enter');
  console.log('final', await latex());

  await browser.close();
}
main();
