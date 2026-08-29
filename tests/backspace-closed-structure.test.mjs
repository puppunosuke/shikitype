// 2026-08-30 修正の回帰テスト。
// 対象: 「Enterで明示的に閉じた」複合構造（∫・Σ・分数・括弧）の直後でBackspaceを
// 1回押すと、構造ごと消えること（拓男の報告「インテグラルがBackspaceで消せない」の修正）。
// 矢印キーで外へ出た場合は従来どおり1文字だけ消える（fix-regression.test.mjsが守る）ので
// ここでは触らない。
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

  async function pressCode(code) { await page.keyboard.press(code); await page.waitForTimeout(15); }
  async function latex() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
  async function stackDepth() { return page.evaluate(() => window.__neoApp.getActiveRow().stack.length); }
  async function resetRow() {
    await page.evaluate(() => {
      while (window.__neoApp.getBaseLayer() !== 'symbol') window.__neoApp.cycleBaseLayer();
      const row = window.__neoApp.getActiveRow();
      row.mf.value = ''; row.mf.position = 0;
      row.stack = []; row.run = []; row.runStack = []; row.history = [];
      row.mf.focus();
    });
    await page.waitForTimeout(60);
  }

  console.log('\n== ∫（KeyU + moveToSubscript経由の構造入力）: 閉じた直後のBackspace ==');
  // KeyUは物理キーではリテラル\intのみなので、conversion経由のopenIntegralを
  // 直接呼んで構造化された∫を作る（変換方式の候補確定と同じ経路）。
  await resetRow();
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    window.__neoApp.dispatchAction(row, { type: 'integral' });
  });
  await pressCode('Digit0'); await pressCode('Enter');
  await pressCode('Digit1'); await pressCode('Enter');
  assertEqual('∫の下限0・上限1を書いて閉じる', await latex(), '\\int_0^1');
  await pressCode('Backspace');
  assertEqual('閉じた∫はBackspace1回で構造ごと消える', await latex(), '');
  assertEqual('stackも空に戻る', await stackDepth(), 0);

  console.log('\n== Σ（KeyO）: 閉じた直後のBackspace ==');
  await resetRow();
  await pressCode('KeyO');
  await pressCode('Digit1'); await pressCode('Enter');
  await pressCode('Digit2'); await pressCode('Enter');
  assertEqual('Σの下限1・上限2を書いて閉じる', await latex(), '\\sum_1^2');
  await pressCode('Backspace');
  assertEqual('閉じたΣはBackspace1回で構造ごと消える', await latex(), '');

  console.log('\n== 分数（KeyL = n/α）: 閉じた直後のBackspace ==');
  await resetRow();
  await pressCode('KeyL');
  await pressCode('Digit1'); await pressCode('Enter');
  await pressCode('Digit2'); await pressCode('Enter');
  assertEqual('1/2を書いて閉じる', await latex(), '\\dfrac12');
  await pressCode('Backspace');
  assertEqual('閉じた分数はBackspace1回で構造ごと消える', await latex(), '');

  console.log('\n== 前後に別の項があっても、閉じた構造だけを1回で消す ==');
  await resetRow();
  await page.evaluate(() => { while (window.__neoApp.getBaseLayer() !== 'latin') window.__neoApp.cycleBaseLayer(); });
  await pressCode('KeyA'); // a
  await page.evaluate(() => { while (window.__neoApp.getBaseLayer() !== 'symbol') window.__neoApp.cycleBaseLayer(); });
  await pressCode('KeyO'); // Σ
  await pressCode('Digit1'); await pressCode('Enter');
  await pressCode('Digit2'); await pressCode('Enter');
  assertEqual('a + Σ_1^2 を書いて閉じる', await latex(), 'a\\sum_1^2');
  await pressCode('Backspace');
  assertEqual('直前のΣだけ消え、aは残る', await latex(), 'a');
  await pressCode('Backspace');
  assertEqual('続けてBackspaceするとaも消える', await latex(), '');

  await browser.close();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
}

main();
