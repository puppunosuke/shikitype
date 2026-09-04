// 2026-08-30 追加（拓男指定・音声指摘1件目）
// 「括弧も中括弧も、JIS配列と同じ打ち方ができるようになってほしい」を実装した回帰テスト。
// Shift+Digit8/9 は丸括弧、Shift+BracketLeft/Right は中括弧を、物理キー位置（event.code）
// で開閉する。閉じる側は文字キー本来の閉じ括弧としてcloseOneLevelを呼ぶ。主操作のEnterとは
// 別の直接経路。
//
// 旧「KeyFで丸括弧を直接挿入」は、変換方式IME導入により routeShikitypeImeKey() の
// `/^Key[A-Z]$/` 分岐がすべての英字物理キーを「読み」としてbufferへ流すようになった
// ため、KeyF単体はもう括弧を開かない（appendConversionText経由で読み"f"になるだけ）。
// KeyFへの専用割り当ては app.js のどこにも残っていない（RESIDENT_SYMBOLSは
// #resident-symbols描画専用の表示定義で、実キー入力には使われない）。現行で丸括弧を
// 出す一般の入口は、変換辞書のreading「かっこ」またはエイリアス"paren"/"parentheses"
// （conversion.js:322）→Enter確定。ここではローマ字物理キーで"paren"と打鍵し、それが
// 現行の変換方式で丸括弧を開けることを検証する（テストを緩めるのではなく、現行の
// 正しい経路へ差し替え）。
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

  console.log('\n== 変換方式の読み"paren"→Enterでも丸括弧が開ける（JIS物理キーとは別経路で併存） ==');
  await resetRow();
  await press('KeyP');
  await press('KeyA');
  await press('KeyR');
  await press('KeyE');
  await press('KeyN');
  await press('Enter'); // 読み確定→かっこ構造を開く
  await press('Digit7');
  await press('Enter'); // 開いた構造を閉じる
  assertEqual('paren → Enter → 7 → Enter で (7)', await latex(), '\\left(7\\right)');

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
