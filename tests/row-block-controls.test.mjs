import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(BASE, { waitUntil: 'networkidle' });

// 3/5行目のEnterが末尾ではなく直後へ入り、DOM番号とactive/focusを揃える。
await page.evaluate(() => window.__neoApp.newNote());
for (let index = 0; index < 4; index += 1) {
  const before = await page.evaluate(() => window.__neoApp.rows.length);
  await page.evaluate((value) => {
    const row = window.__neoApp.getActiveRow();
    row.mf.value = value;
    row.mf.position = row.mf.lastOffset;
    row.mf.focus();
  }, `r${index + 1}`);
  await page.waitForFunction(() => document.activeElement === window.__neoApp.getActiveRow().mf);
  await page.keyboard.press('Enter');
  await page.waitForFunction((count) => window.__neoApp.rows.length === count + 1, before);
  await page.waitForTimeout(40);
}
await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  row.mf.value = 'r5'; row.mf.position = row.mf.lastOffset;
  window.__neoApp.rows[2].mf.focus();
});
await page.waitForFunction(() => document.activeElement === window.__neoApp.rows[2].mf && window.__neoApp.getActiveRow() === window.__neoApp.rows[2]);
await page.keyboard.press('Enter');
await page.waitForTimeout(30);
const inserted = await page.evaluate(() => ({
  values: window.__neoApp.rows.map((row) => row.mf.value),
  active: window.__neoApp.rows.indexOf(window.__neoApp.getActiveRow()),
  domValues: [...document.querySelectorAll('.row math-field')].map((mf) => mf.value),
  deleteVisible: getComputedStyle(document.querySelector('.row-delete')).display,
}));
ok('行3/5でEnterすると直後の4番へ挿入する', JSON.stringify(inserted.values) === JSON.stringify(['r1', 'r2', 'r3', '', 'r4', 'r5']) && JSON.stringify(inserted.domValues) === JSON.stringify(inserted.values) && inserted.active === 3, inserted);
ok('行モードではblock削除ボタンを表示しない', inserted.deleteVisible === 'none', inserted.deleteVisible);

await page.keyboard.press('Backspace');
await page.waitForTimeout(30);
const afterRowDelete = await page.evaluate(() => ({ values: window.__neoApp.rows.map((row) => row.mf.value), active: window.__neoApp.rows.indexOf(window.__neoApp.getActiveRow()) }));
ok('空blockのBackspaceは行を削除し前のblockへfocusする', JSON.stringify(afterRowDelete.values) === JSON.stringify(['r1', 'r2', 'r3', 'r4', 'r5']) && afterRowDelete.active === 2, afterRowDelete);

await page.evaluate(() => window.__neoApp.newNote());
await page.keyboard.press('Backspace');
const lastRow = await page.evaluate(() => ({ count: window.__neoApp.rows.length, active: window.__neoApp.rows.indexOf(window.__neoApp.getActiveRow()) }));
ok('行モードの最後の空blockはBackspaceでも入力先として残す', lastRow.count === 1 && lastRow.active === 0, lastRow);
ok('画面エラーなし', errors.length === 0, errors);

await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
