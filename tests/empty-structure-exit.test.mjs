// 空の入れ子から矢印で離れた後も、Backspaceでその構造を通常どおり取り消せること。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = process.env.NEO_BASE ?? 'http://localhost:8893/app.html';
let failures = 0;
function ok(label, value, detail = '') {
  if (value) console.log(`  OK  ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}`, detail); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE);
  await page.waitForSelector('math-field');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('math-field');

  async function reset(latex = '') {
    await page.evaluate((next) => {
      const row = window.__neoApp.getActiveRow();
      row.mf.value = next;
      row.mf.position = row.mf.lastOffset;
      row.stack = []; row.run = []; row.runStack = []; row.history = []; row.detachedFrames = [];
      row.mf.focus();
    }, latex);
  }
  async function value() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
  async function press(code) { await page.keyboard.press(code); await page.waitForTimeout(30); }
  async function state() {
    return page.evaluate(() => {
      const row = window.__neoApp.getActiveRow();
      return { latex: row.mf.value, position: row.mf.position, lastOffset: row.mf.lastOffset,
        stack: row.stack.map((frame) => ({ kind: frame.kind, slot: frame.slotIndex })),
        detached: row.detachedFrames.map((frame) => frame.kind) };
    });
  }

  console.log('\n== empty structure arrow exit ==');
  await reset();
  await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'integral' }));
  await press('ArrowRight');
  await press('Backspace');
  ok('empty integral can be removed after ArrowRight exit', await value() === '', await value());

  await reset();
  await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'integral' }));
  await press('Enter'); // 下限を空のまま上限へ進む
  await press('ArrowRight');
  await press('ArrowRight');
  await press('Backspace');
  ok('empty integral can be removed after advancing to its second slot then ArrowRight exit', await value() === '', await state());

  await reset();
  await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'integral' }));
  await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'digit', value: '0' }));
  await press('Enter');
  // 上限を閉じてから外へ出る。空の上限内でのArrowRightはまだ構造の内部である。
  await press('Enter'); await press('ArrowRight');
  await press('Backspace');
  ok('a non-empty integral is erased wholesale after ArrowRight exit', await value() === '', await value());

  await reset('x');
  await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'open', kind: 'sup' }));
  await press('ArrowRight');
  await press('Backspace');
  ok('empty power can be cancelled after ArrowRight exit', await value() === 'x', await value());

  console.log('\n== empty structure row exit ==');
  await reset('a');
  await press('Enter');
  await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'integral' }));
  await press('ArrowUp');
  await press('ArrowDown');
  await press('Backspace');
  ok('empty integral can be removed after leaving and returning to its row', await value() === '', await state());

  await reset('a');
  await press('Enter');
  await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'integral' }));
  await press('Enter');
  await press('ArrowUp'); await press('ArrowDown');
  await press('ArrowRight'); await press('ArrowRight');
  await press('Backspace');
  ok('empty second-slot integral remains removable after a row round trip', await value() === '', await state());

  console.log('\n== empty structure Enter exit ==');
  await reset();
  await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'integral' }));
  await press('Enter'); await press('Enter');
  await press('Backspace');
  ok('empty integral can be removed after Enter closes its slots', await value() === '', await state());

  await browser.close();
  console.log(`\n=== RESULT: ${failures ? 'FAIL' : 'PASS'} ===`);
  if (failures) process.exitCode = 1;
}

main();
