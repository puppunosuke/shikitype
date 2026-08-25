// 再変換（確定直後に限り、Backspaceで読みへ戻す）の回帰。
// SHIKITYPE変換方式で候補を確定した直後だけ、Backspace1回で確定前の読みへ戻り
// 候補リストが再度出ることを確認する。カーソル移動や他の入力を挟んだ場合は
// 通常のBackspace（構造化削除）へ戻ることも確認する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.notes.v1'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => window.__neoApp.setInputSystem('conversion', false));

  async function pressCode(code, mods = {}) {
    const held = [];
    if (mods.shift) { await page.keyboard.down('Shift'); held.push('Shift'); }
    if (mods.ctrl) { await page.keyboard.down('Control'); held.push('Control'); }
    await page.keyboard.press(code);
    for (const m of held.reverse()) await page.keyboard.up(m);
    await page.waitForTimeout(15);
  }
  async function typeRaw(text) { for (const char of text.toUpperCase()) await pressCode(`Key${char}`); }
  async function value() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
  async function conversion() { return page.evaluate(() => window.__neoApp.getConversionState()); }
  async function reset(layer = 'symbol') {
    await page.evaluate((wanted) => {
      const row = window.__neoApp.getActiveRow();
      row.mf.value = ''; row.mf.executeCommand(['switchMode', 'math']); row.mf.position = 0;
      row.stack = []; row.run = []; row.runStack = []; row.history = []; row.nativeTextOpen = false; row.lastConfirm = null;
      Object.assign(row.conversion, { raw: '', reading: '', searchReading: '', pending: '', navigation: false, selectedIndex: 0 });
      row.conversion.preview.textContent = ''; row.conversion.preview.hidden = true;
      for (let guard = 0; window.__neoApp.getBaseLayer() !== wanted && guard < 4; guard += 1) window.__neoApp.cycleBaseLayer(false);
      row.inputProxy.focus();
    }, layer);
    await page.waitForTimeout(20);
  }

  console.log('\n== 1. 確定直後のBackspaceは読みへ戻る ==');
  await reset('symbol');
  await typeRaw('integral');
  await pressCode('Enter');
  const confirmed = await value();
  ok('積分記号が確定する', confirmed.includes('\\int'), confirmed);
  await pressCode('Backspace');
  const reverted = await value();
  const state = await conversion();
  ok('Backspace1回で確定前（空）へ戻る', reverted === '', reverted);
  ok('読み(integral)が復元され候補が再度出る', state?.raw === 'integral' && state.candidates.includes('integral'), state);

  console.log('\n== 2. 2回目のBackspaceは読みを1文字ずつ消す（通常の再変換終了後の挙動） ==');
  await pressCode('Backspace');
  const afterSecondBackspace = await conversion();
  ok('2回目は読みの末尾を1文字消す（integral -> integra）', afterSecondBackspace?.raw === 'integra', afterSecondBackspace);

  console.log('\n== 3. カーソル移動を挟むと再変換の対象外になる ==');
  await reset('symbol');
  await typeRaw('integral');
  await pressCode('Enter');
  const confirmed2 = await value();
  ok('積分記号が確定する(2)', confirmed2.includes('\\int'), confirmed2);
  await pressCode('ArrowLeft'); // 何かを挟む
  await pressCode('ArrowRight'); // 元のキャレット位置へ戻しても、一度挟んだ操作で対象外になる
  await pressCode('Backspace');
  const afterMove = await value();
  ok('カーソル移動を挟むと再変換されず通常のBackspaceになる', afterMove !== confirmed2, { before: confirmed2, after: afterMove });

  console.log('\n== 4. 別の候補確定を挟むと直前の再変換は対象外になる ==');
  await reset('symbol');
  await typeRaw('integral');
  await pressCode('Enter');
  await typeRaw('lim');
  await pressCode('Enter');
  const twoConfirms = await value();
  ok('∫の後にlimも確定する', twoConfirms.includes('\\int') && twoConfirms.includes('\\lim'), twoConfirms);
  await pressCode('Backspace');
  const afterThirdBackspace = await value();
  const stateAfterThird = await conversion();
  ok('直近の確定（lim）だけが読みへ戻る。∫はそのまま残る', afterThirdBackspace.includes('\\int') && !afterThirdBackspace.includes('\\lim'), afterThirdBackspace);
  ok('読みはlim側で再度出る', stateAfterThird?.raw === 'lim', stateAfterThird);

  ok('画面エラーなし', errors.length === 0, errors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) process.exit(1);
}

main();
