// Enter を構造の進行キーへ統一した回帰。実際のキーボードと画面キーの両方を通し、
// SHIKITYPE候補の3種類の分数が別々の固定アクションへ届くことも確認する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0; const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed += 1; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
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
  await page.waitForTimeout(50);
}
async function typeRaw(text) { for (const char of text.toUpperCase()) await page.keyboard.press(char === '-' ? 'Minus' : `Key${char}`); }
async function state() { return page.evaluate(() => ({
  latex: window.__neoApp.getActiveRow().mf.value,
  stack: window.__neoApp.getActiveRow().stack.map((frame) => ({ kind: frame.kind, slot: frame.slotIndex })),
  rows: window.__neoApp.rows.length,
  candidates: window.__neoApp.getConversionState().candidates,
})); }
async function choose(raw, id) {
  await typeRaw(raw);
  const s = await state(); const index = s.candidates.indexOf(id);
  ok(`${raw} に ${id} が出る`, index >= 0, s.candidates);
  await page.keyboard.press('Tab');
  for (let i = 0; i < index; i += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(35);
}
async function seedTerm(value = '7') {
  await page.evaluate((term) => {
    const row = window.__neoApp.getActiveRow();
    row.mf.executeCommand(['insert', term, { insertionMode: 'insertAfter', format: 'latex' }]);
    row.run.push({ kind: 'digits', start: 0, end: term.length });
  }, value);
}

console.log('\n== Enter advances exactly one structural level ==');
await reset();
await choose('paren', 'parentheses');
await page.keyboard.press('Digit1');
const parenBefore = await state();
await page.keyboard.press('Enter');
const parenAfter = await state();
ok('physical Enter closes parenthesis without creating a row', parenAfter.latex === '\\left(1\\right)' && parenAfter.stack.length === 0 && parenAfter.rows === parenBefore.rows, parenAfter);

await reset();
await choose('sqrt', 'sqrt');
await page.keyboard.press('Digit9');
const screenBefore = await state();
await page.click('[data-special="Enter"]');
const screenAfter = await state();
ok('screen Enter closes an open structure without creating a row', screenAfter.latex === '\\sqrt9' && screenAfter.stack.length === 0 && screenAfter.rows === screenBefore.rows, screenAfter);

await reset();
await choose('integral', 'integral');
const integralRows = (await state()).rows;
await page.keyboard.press('Digit0'); await page.keyboard.press('Enter');
ok('integral first Enter advances lower to upper', (await state()).stack[0]?.kind === 'integral' && (await state()).stack[0]?.slot === 1, await state());
await page.keyboard.press('Digit1'); await page.keyboard.press('Enter');
const integralAfter = await state();
ok('integral second Enter closes only integral and stays in its row', integralAfter.latex === '\\int_0^1' && integralAfter.stack.length === 0 && integralAfter.rows === integralRows, integralAfter);

console.log('\n== Space no longer advances structures; Shift+Enter reopens ==');
await reset();
await choose('paren', 'parentheses'); await page.keyboard.press('Digit2');
await page.keyboard.press('Space');
ok('physical Space does not close an open structure', (await state()).stack.length === 1, await state());
await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Enter');
ok('Shift+Enter reopens one level after structural Enter', (await state()).stack.length === 1, await state());

console.log('\n== ぶんすう offers three distinct, keyboard-selectable fraction actions ==');
await reset(); await seedTerm(); await typeRaw('bunsuu');
const fractionCandidates = await state();
ok('ぶんすう shows all three choices together', ['fraction', 'fraction-structure', 'fraction-empty'].every((id) => fractionCandidates.candidates.includes(id)), fractionCandidates);
const labels = await page.locator('.conversion-candidate:not([hidden])').evaluateAll((items) => items.map((item) => item.textContent?.trim()));
ok('fraction choices use only their structural labels', ['a/□', '□/a', '□/□'].every((label) => labels.includes(label)), labels);

await reset(); await seedTerm(); await choose('bunsuu', 'fraction');
ok('a/□ keeps the previous term as numerator and enters denominator', (await state()).latex === '\\dfrac{7}{\\placeholder{}}' && (await state()).stack[0]?.kind === 'afrac', await state());

await reset(); await seedTerm(); await choose('bunsuu', 'fraction-structure');
ok('□/a keeps the previous term as denominator and enters numerator', (await state()).latex === '\\dfrac{\\placeholder{}}{7}' && (await state()).stack[0]?.kind === 'nfrac', await state());

await reset(); await choose('bunsuu', 'fraction-empty');
await page.keyboard.press('Digit1'); await page.keyboard.press('Enter');
ok('□/□ first Enter advances numerator to denominator', (await state()).stack[0]?.kind === 'nfrac' && (await state()).stack[0]?.slot === 1, await state());
await page.keyboard.press('Digit2'); await page.keyboard.press('Enter');
const emptyFraction = await state();
ok('□/□ second Enter closes fraction in the same row', emptyFraction.latex === '\\dfrac12' && emptyFraction.stack.length === 0, emptyFraction);
await page.keyboard.press('Backspace');
ok('Backspace after closing the fraction removes the closed structure', (await state()).latex === '', await state());

console.log('\n== text remains an explicit non-row Enter close ==');
await reset();
const textRows = (await state()).rows;
await page.click('[data-special="Text"]'); await page.waitForTimeout(30);
await page.keyboard.type('memo'); await page.keyboard.press('Enter');
const textAfter = await state();
ok('text Enter closes text and does not create a row', textAfter.latex.includes('\\text{memo}') && textAfter.stack.length === 0 && textAfter.rows === textRows, textAfter);

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
