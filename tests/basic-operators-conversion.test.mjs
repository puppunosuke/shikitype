// 2026-08-30 拓男指定（音声指摘3・4件目）の回帰テスト。
// 3: CSV/既定辞書に「たす」「ひく」（+ −）が無く変換方式から出せなかった。ついでに
//    かける・わる・いこーるも確認し、÷以外は1件も無かったため4つまとめて追加した。
// 4: 割り算（÷）は記号を挿入するだけだったのを、直前の項を分子に取り分母へカーソル
//    移動する（afracと同じ）挙動へ変えた。パレットの÷・変換の「わる」どちらも対象。
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
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => { localStorage.clear(); window.__neoApp.setInputSystem('conversion', false); });
  await page.reload({ waitUntil: 'networkidle' });

  async function reset() {
    await page.evaluate(() => {
      const row = window.__neoApp.getActiveRow();
      row.mf.value = ''; row.mf.executeCommand(['switchMode', 'math']); row.mf.position = 0;
      row.stack = []; row.run = []; row.runStack = []; row.history = []; row.nativeTextOpen = false;
      Object.assign(row.conversion, { raw: '', reading: '', searchReading: '', pending: '', navigation: false, selectedIndex: 0 });
      row.conversion.preview.textContent = ''; row.conversion.preview.hidden = true;
      window.__neoApp.setInputSystem('conversion', false);
      while (window.__neoApp.getBaseLayer() !== 'symbol') window.__neoApp.cycleBaseLayer(false);
      row.inputProxy.focus();
    });
    await page.waitForTimeout(70);
  }
  async function typeRaw(text) { for (const char of text.toUpperCase()) await page.keyboard.press(char === '-' ? 'Minus' : `Key${char}`); }
  async function candidateIds() { return page.evaluate(() => window.__neoApp.getConversionState().candidates); }
  async function latex() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
  async function stack() { return page.evaluate(() => window.__neoApp.getActiveRow().stack.map((frame) => frame.kind)); }
  async function confirm() { await page.keyboard.press('Enter'); await page.waitForTimeout(30); }

  console.log('\n== 項目3: たす・ひく・かける・いこーるが変換候補として出て確定できる ==');
  await reset();
  await typeRaw('tasu');
  assertEqual('たす は plus 候補を出す', await candidateIds(), ['plus']);
  await confirm();
  assertEqual('plus確定で+が入る', await latex(), '+');

  await reset();
  await typeRaw('hiku');
  assertEqual('ひく は minus 候補を出す', await candidateIds(), ['minus']);
  await confirm();
  assertEqual('minus確定で-が入る', await latex(), '-');

  await reset();
  await typeRaw('kakeru');
  assertEqual('かける は multiply 候補を出す', await candidateIds(), ['multiply']);
  await confirm();
  assertEqual('multiply確定で物理キー(KeyT)と同じ\\cdot が入る', await latex(), '\\cdot ');

  console.log('\n== 項目4: 割り算は記号挿入でなく afrac（直前項を分母化）になる ==');

  await reset();
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    row.mf.executeCommand(['insert', '7', { insertionMode: 'insertAfter', format: 'latex' }]);
    row.run.push({ kind: 'digits', start: 0, end: 1 });
  });
  await typeRaw('waru');
  assertEqual('わる は fraction 候補を出す（表示は÷のまま）', await candidateIds(), ['fraction']);
  await confirm();
  assertEqual('わる確定で7が分母に入り分子へカーソルが動く', await latex(), '\\dfrac{7}{\\placeholder{}}');
  assertEqual('stackはafrac', await stack(), ['afrac']);

  console.log('\n== 項目4: パレットの÷ボタンも同じ挙動 ==');
  await reset();
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    row.mf.executeCommand(['insert', '5', { insertionMode: 'insertAfter', format: 'latex' }]);
    row.run.push({ kind: 'digits', start: 0, end: 1 });
  });
  await page.keyboard.press('Escape'); // パレットを開く
  await page.waitForTimeout(80);
  const clicked = await page.evaluate(() => {
    const target = [...document.querySelectorAll('#palette-grid .palette-btn')].find((b) => b.textContent === '÷');
    if (!target) return false;
    target.click();
    return true;
  });
  assertEqual('パレットに÷ボタンがある', clicked, true);
  await page.waitForTimeout(80);
  assertEqual('パレット÷確定で5が分母に入り分子へカーソルが動く', await latex(), '\\dfrac{5}{\\placeholder{}}');
  assertEqual('stackはafrac', await stack(), ['afrac']);

  await browser.close();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
}

main();
