import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#sidebar-toggle');
// 整数の性質単元へ切替（congruence系が先頭に来る）
await page.click('#unit-subject-choice button:has-text("数A")');
await page.click('#unit-choice button:has-text("整数の性質")');
await page.click('#sidebar-close');
await page.keyboard.press('KeyA'); // 変数 a （記号層なのでKeyAは√...) 標準トグルでは記号が基底なのでaは打てない。Tabで英字へ
await page.keyboard.press('Tab');
await page.keyboard.press('KeyA');
await page.keyboard.press('Tab'); // 記号へ戻す
await page.keyboard.press('Escape'); // パレット
await page.click('#palette-grid .palette-btn:has-text("≡")');
await page.keyboard.press('Tab');
await page.keyboard.press('KeyB');
await page.keyboard.press('Tab');
await page.keyboard.press('Escape');
await page.click('#palette-grid .palette-btn:has-text("(mod n)")');
const val = await page.evaluate(() => window.__neoApp.getActiveRow().mf.value);
console.log('latex:', val);
await page.locator('.row math-field').first().screenshot({ path: 'tests/out-verify-mod2.png' });
await browser.close();
