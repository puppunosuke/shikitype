// 2026-08-30 追加（拓男指定・音声指摘1件目）
// 「括弧も中括弧も、JIS配列と同じ打ち方ができるようになってほしい」を実装した回帰テスト。
// Shift+Digit8/9 は丸括弧、Shift+BracketLeft/Right は中括弧を、物理キー位置（event.code）
// で開閉する。既存のKeyF（丸括弧）は残したまま併存させる方針（根拠はapp.js側のコメント）。
// 閉じる側は新しい「閉じ方のルール」を増やさず、Spaceと同じcloseOneLevelを呼ぶだけにする。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let pass = 0; let fail = 0; const failures = [];
function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  OK  ${label}`); }
  else { fail++; failures.push({ label, actual, expected }); console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  await page.goto(BASE);
  await page.waitForSelector('math-field');
  await page.waitForTimeout(200);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('math-field');
  await page.waitForTimeout(200);
  await page.click('math-field');
  await page.waitForTimeout(80);

  async function press(code, shift = false) {
    if (shift) await page.keyboard.down('Shift');
    await page.keyboard.press(code);
    if (shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(15);
  }
  async function latex() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
  async function resetRow() {
    await page.evaluate(() => {
      const row = window.__neoApp.getActiveRow();
      row.mf.value = ''; row.mf.position = 0; row.stack = []; row.run = []; row.runStack = []; row.history = [];
      row.mf.focus();
    });
    await page.waitForTimeout(60);
  }

  console.log('\n== Shift+Digit8/9 で丸括弧 ==');
  await resetRow();
  await press('Digit8', true);
  await press('Digit5');
  await press('Digit9', true);
  assertEqual('Shift+8 → 5 → Shift+9 で (5)', await latex(), '\\left(5\\right)');

  console.log('\n== Shift+BracketLeft/Right で中括弧 ==');
  await resetRow();
  await press('BracketLeft', true);
  await press('Digit3');
  await press('BracketRight', true);
  assertEqual('Shift+[ → 3 → Shift+] で {3}', await latex(), '\\{3\\}');

  console.log('\n== 既存のKeyF（丸括弧）は消えていない ==');
  await resetRow();
  await press('KeyF');
  await press('Digit7');
  await press('Space');
  assertEqual('KeyF → 7 → Space でも従来どおり (7)', await latex(), '\\left(7\\right)');

  console.log('\n== Shiftなしの Digit8/9 は従来どおり数字 ==');
  await resetRow();
  await press('Digit8');
  await press('Digit9');
  assertEqual('Shiftなしは数字の89のまま', await latex(), '89');

  await browser.close();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
}

main();
