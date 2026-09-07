// 現行の変換入力で、構造入力・同一block改行・構造外Backspaceを実DOMで確認する。
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
    window.__neoApp.newNote();
    const row = window.__neoApp.getActiveRow();
    window.__neoApp.setInputSystem('conversion', false);
    row.mf.value = ''; row.mf.position = 0; row.stack = []; row.run = []; row.runStack = []; row.history = [];
    row.inputProxy.focus();
  });
}
async function typeReading(text) {
  for (const char of text.toUpperCase()) await page.keyboard.press(char === '-' ? 'Minus' : `Key${char}`);
}
async function state() { return page.evaluate(() => ({
  latex: window.__neoApp.getActiveRow().mf.value,
  stack: window.__neoApp.getActiveRow().stack.map((frame) => ({ kind: frame.kind, slot: frame.slotIndex })),
  rows: window.__neoApp.rows.length,
})); }
async function confirm(reading, id) {
  await typeReading(reading);
  const ids = await page.evaluate(() => window.__neoApp.getConversionState().candidates);
  ok(`${reading} は ${id} の候補を出す`, ids.includes(id), ids);
  const index = ids.indexOf(id);
  for (let i = 0; i < index; i += 1) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(20);
}

console.log('\n== current conversion structural contract ==');
await reset();
await confirm('paren', 'parentheses'); await page.keyboard.press('Digit1'); await page.keyboard.press('Enter');
ok('括弧候補はEnterで閉じ、本文を保つ', (await state()).latex === '\\left(1\\right)', await state());

await reset();
await page.keyboard.press('Digit2'); await confirm('bunno', 'fraction-structure'); await page.keyboard.press('Digit1'); await page.keyboard.press('Enter');
ok('直前項を分母にする分数候補は本文とslotを保つ', (await state()).latex === '\\dfrac12' && (await state()).stack.length === 0, await state());

await reset();
await confirm('x', 'latin-lower-x'); await confirm('jou', 'power'); await page.keyboard.press('Digit2'); await page.keyboard.press('Enter');
ok('累乗候補は直前項の上付きとして確定する', (await state()).latex === 'x^2', await state());

await reset();
await page.keyboard.press('Digit4');
const beforeBreak = await state();
await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
const afterBreak = await state();
ok('Shift+Enterは同一blockで改行する', afterBreak.rows === 1 && afterBreak.stack.length === 0 && afterBreak.latex.includes('\\\\'), { beforeBreak, afterBreak });

await reset();
await confirm('integral', 'integral'); await page.keyboard.press('Digit0'); await page.keyboard.press('Enter'); await page.keyboard.press('Digit1'); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Backspace');
ok('構造の外のBackspaceは中身のある積分を一打で消す', (await state()).latex === '' && (await state()).stack.length === 0, await state());

await reset();
await page.keyboard.press('Digit1'); await page.keyboard.press('Digit2'); await page.keyboard.press('Digit3'); await page.keyboard.press('Enter');
ok('構造が無いEnterは次の行を作る', (await state()).rows === 2, await state());

await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exitCode = 1;
