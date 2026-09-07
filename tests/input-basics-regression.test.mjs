// 入力方式の基礎契約: 文キー変換、ブロック内改行、構造一項削除、Mac修飾キー。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = process.env.NEO_BASE ?? 'http://localhost:8893/app.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const failures = [];
function ok(label, value, detail = value) {
  if (value) console.log(`  OK  ${label}`);
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
await page.evaluate(() => { localStorage.clear(); window.__neoApp.newNote(); window.__neoApp.setInputSystem('conversion', false); });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('math-field');

async function press(code, modifiers = {}) {
  const keys = [];
  if (modifiers.shift) { await page.keyboard.down('Shift'); keys.push('Shift'); }
  if (modifiers.meta) { await page.keyboard.down('Meta'); keys.push('Meta'); }
  await page.keyboard.press(code);
  for (const key of keys.reverse()) await page.keyboard.up(key);
  await page.waitForTimeout(25);
}
async function typeReading(text) {
  for (const char of text.toUpperCase()) await press(`Key${char}`);
  await press('Enter');
}
async function latex() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }

console.log('\n== text candidate ==');
await typeReading('bunshou');
ok('ぶんしょう → Enter opens native text entry', await page.evaluate(() => window.__neoApp.getActiveRow().nativeTextOpen));
await page.keyboard.type('memo');
await press('Enter');
ok('text candidate closes normally and keeps text', (await latex()).includes('memo'), await latex());

console.log('\n== one block line break ==');
await page.evaluate(() => window.__neoApp.newNote());
await page.click('math-field');
await press('Digit1');
await press('Enter', { shift: true });
await press('Digit2');
const lines = await latex();
ok('Shift+Enter keeps one block and creates MathLive line break', (await page.evaluate(() => window.__neoApp.rows.length)) === 1 && lines.includes('\\\\') && lines.includes('1') && lines.includes('2'), lines);

console.log('\n== selection and Mac undo ==');
await page.evaluate(() => window.__neoApp.newNote());
await page.click('math-field');
await press('Digit1'); await press('Digit2'); await press('Digit3');
await press('ArrowLeft', { shift: true });
await press('ArrowLeft', { shift: true });
const selection = await page.evaluate(() => window.__neoApp.getActiveRow().mf.selection.ranges[0]);
ok('Shift+Arrow selects an atom in the formula', selection[0] !== selection[1], selection);
await press('ArrowRight', { shift: true });
const shrunkSelection = await page.evaluate(() => window.__neoApp.getActiveRow().mf.selection.ranges[0]);
ok('Shift+Arrowの方向を反転すると選択が一項ずつ縮む', Math.abs(shrunkSelection[1] - shrunkSelection[0]) < Math.abs(selection[1] - selection[0]), { selection, shrunkSelection });
await press('KeyZ', { meta: true });
ok('Cmd+Z undoes the latest formula edit', await latex() === '12', await latex());

console.log('\n== selection copy clears block copy mode ==');
await page.evaluate(() => {
  window.__neoApp.newNote();
  const clipboard = navigator.clipboard;
  const nativeWriteText = clipboard.writeText.bind(clipboard);
  window.__selectionClipboardWrites = [];
  // 書込み内容を観測するだけで、実際のClipboard APIへ必ず委譲する。no-op mockでは
  // Ctrl/Cmd+CがOSクリップボードへ届くかを検証できない。
  Object.defineProperty(clipboard, 'writeText', {
    configurable: true,
    value: async (text) => {
      window.__selectionClipboardWrites.push(text);
      await nativeWriteText(text);
    },
  });
});
await page.click('math-field');
await press('Digit1');
await press('Digit2');
await press('Digit3');
await press('KeyC', { meta: true }); // 先にブロックコピーを作る
await press('ArrowLeft', { shift: true });
await press('ArrowLeft', { shift: true });
const selectedBeforeCopy = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  const [start, end] = row.mf.selection.ranges[0];
  return {
    range: [start, end],
    visual: row.mf.matches(':focus') && row.mf.shadowRoot.querySelectorAll('.ML__selected').length > 0,
  };
});
ok('Shift+Left 2回で末尾2項を可視選択する', selectedBeforeCopy.visual && Math.abs(selectedBeforeCopy.range[1] - selectedBeforeCopy.range[0]) === 2, selectedBeforeCopy);
await press('KeyC', { meta: true }); // 式の一部コピーはブロックコピーを解除する
const copiedSelection = await page.evaluate(async () => ({
  writes: window.__selectionClipboardWrites,
  clipboard: await navigator.clipboard.readText(),
}));
ok('逆向き選択でも実際のClipboard APIへ選択式23を書き込む', copiedSelection.writes.at(-1) === '23' && copiedSelection.clipboard === '23', copiedSelection);
await press('KeyV', { meta: true });
await page.waitForTimeout(60);
const afterSelectionPaste = await page.evaluate(() => ({ rows: window.__neoApp.rows.length, latex: window.__neoApp.getActiveRow().mf.value }));
ok('部分コピー後のCmd+Vは古いblockを増やさず選択範囲へ貼り付ける', afterSelectionPaste.rows === 1 && afterSelectionPaste.latex === '123', afterSelectionPaste);

await browser.close();
console.log(`\n=== RESULT: ${failures.length ? 'FAIL' : 'PASS'} ===`);
if (failures.length) process.exitCode = 1;
