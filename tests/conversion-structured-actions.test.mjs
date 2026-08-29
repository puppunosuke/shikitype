// SHIKITYPEの候補確定が平坦なLaTex挿入を迂回し、既存の構造入力へ接続されることを
// 実キー経路で確認する。ユーザーCSVの文字列を命令として実行しない実装の回帰も兼ねる。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
const failures = []; let passed = 0;
function ok(label, value, detail = value) {
  if (value) { passed += 1; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}
await page.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
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
async function typeRaw(text) {
  for (const char of text.toUpperCase()) await page.keyboard.press(char === '-' ? 'Minus' : `Key${char}`);
}
async function candidateIds() { return page.evaluate(() => window.__neoApp.getConversionState().candidates); }
async function latex() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
async function stack() { return page.evaluate(() => window.__neoApp.getActiveRow().stack.map((frame) => ({ kind: frame.kind, slot: frame.slotIndex }))); }
async function confirm(raw, id) {
  await typeRaw(raw);
  const ids = await candidateIds();
  ok(`${raw} は ${id} の候補を出す`, ids.includes(id), ids);
  const index = ids.indexOf(id);
  if (index > 0) for (let i = 0; i <= index; i += 1) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(25);
}

console.log('\n== SHIKITYPE structural conversion actions ==');
await reset();
await page.keyboard.press('Digit2');
await confirm('bunno', 'fraction-structure');
ok('2 → ぶんの は直前項を分母にして分子へ入る', (await stack())[0]?.kind === 'nfrac' && (await latex()).includes('\\dfrac{\\placeholder{}}{2}'), { latex: await latex(), stack: await stack() });
await page.keyboard.press('Digit1');
await page.keyboard.press('Space');
ok('2 → ぶんの → 1 は 1/2 になり、Spaceで構造を閉じられる', (await latex()) === '\\dfrac12' && (await stack()).length === 0, { latex: await latex(), stack: await stack() });

await reset();
await confirm('x', 'latin-lower-x');
await confirm('jou', 'power');
await page.keyboard.press('Digit2'); await page.keyboard.press('Space');
ok('x → じょう は直前のxに上付きスロットを開く', (await latex()) === 'x^2', { latex: await latex(), stack: await stack() });

await reset();
await confirm('x', 'latin-lower-x');
await confirm('njou', 'power-n');
await page.keyboard.press('Space');
ok('x → nじょう はnを上付きに事前入力する', (await latex()) === 'x^{n}', { latex: await latex(), stack: await stack() });

await reset();
await confirm('x', 'latin-lower-x');
await confirm('xjou', 'power-x');
await page.keyboard.press('Space');
ok('x → xじょう はxを上付きに事前入力する', (await latex()) === 'x^{x}', { latex: await latex(), stack: await stack() });

await reset();
await confirm('sqrt', 'sqrt');
await page.keyboard.press('Digit9'); await page.keyboard.press('Space');
ok('sqrt候補は根号スロットを開く', (await latex()) === '\\sqrt9', { latex: await latex(), stack: await stack() });

await reset();
await confirm('absolute', 'absolute');
await page.keyboard.press('Digit5'); await page.keyboard.press('Space');
ok('absolute候補は絶対値スロットを開く', (await latex()) === '\\left|5\\right|', { latex: await latex(), stack: await stack() });

await reset();
await confirm('paren', 'parentheses');
await page.keyboard.press('Digit3'); await page.keyboard.press('Space');
ok('paren候補は括弧スロットを開く', (await latex()) === '\\left(3\\right)', { latex: await latex(), stack: await stack() });

await reset();
await confirm('souwakigou', 'sum-operator');
await page.keyboard.press('Digit1'); await page.keyboard.press('Space'); await page.keyboard.press('Digit2'); await page.keyboard.press('Space');
ok('総和記号候補は下限→上限を編集できる', (await latex()) === '\\sum_1^2', { latex: await latex(), stack: await stack() });

await reset();
await confirm('integral', 'integral');
await page.keyboard.press('Digit0'); await page.keyboard.press('Space'); await page.keyboard.press('Digit1'); await page.keyboard.press('Space');
ok('積分候補は下限→上限を編集できる', (await latex()) === '\\int_0^1', { latex: await latex(), stack: await stack() });

await reset();
await confirm('lim', 'limit');
await confirm('n', 'latin-lower-n');
await page.keyboard.press('Space');
ok('lim候補は極限の下付きスロットを開く', (await latex()) === '\\lim_{n}', { latex: await latex(), stack: await stack() });

await reset();
await confirm('sqrt', 'sqrt');
await page.keyboard.press('Backspace');
ok('空の構造候補はBackspace一回で取り消せる', (await latex()) === '' && (await stack()).length === 0, { latex: await latex(), stack: await stack() });

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
