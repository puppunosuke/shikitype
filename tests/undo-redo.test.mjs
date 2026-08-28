// 取り消し・やり直し（Undo/Redo）の回帰。
// 汎用の操作履歴スタック（1本）が、連続入力のまとめ・ブロック追加/削除・
// 候補確定・カーソル/フォーカス復帰・設定モーダル/文章ブロックの不干渉を
// すべて満たすことを、実DOMの状態で確認する。
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

  async function pressCode(code, mods = {}) {
    const held = [];
    if (mods.shift) { await page.keyboard.down('Shift'); held.push('Shift'); }
    if (mods.ctrl) { await page.keyboard.down('Control'); held.push('Control'); }
    await page.keyboard.press(code);
    for (const m of held.reverse()) await page.keyboard.up(m);
    await page.waitForTimeout(15);
  }
  async function undo() { await pressCode('KeyZ', { ctrl: true }); }
  async function redoShift() { await pressCode('KeyZ', { ctrl: true, shift: true }); }
  async function redoY() { await pressCode('KeyY', { ctrl: true }); }
  async function switchLayer(layer) {
    let guard = 0;
    while (await page.evaluate(() => window.__neoApp.getBaseLayer()) !== layer && guard++ < 3) await pressCode('Tab');
  }
  async function value(index) { return page.evaluate((i) => window.__neoApp.rows[i]?.mf.value, index); }
  async function rowsCount() { return page.evaluate(() => window.__neoApp.rows.length); }
  async function activeIndex() { return page.evaluate(() => window.__neoApp.rows.indexOf(window.__neoApp.getActiveRow())); }
  async function focusInfo() {
    return page.evaluate(() => {
      const row = window.__neoApp.getActiveRow();
      return {
        onProxy: document.activeElement === row.inputProxy,
        onMathfield: document.activeElement === row.mf,
        position: row.mf.position,
      };
    });
  }

  console.log('\n== 1. 連続入力はまとめて1単位で戻る ==');
  await page.evaluate(() => window.__neoApp.newNote());
  await page.click('math-field');
  await switchLayer('latin');
  await pressCode('KeyX');
  await pressCode('KeyY'); // 'xy' を600ms以内に続けて打つ → 1つの取り消し単位
  await page.waitForTimeout(650); // coalesceを確定させる
  await pressCode('KeyZ'); // 'xyz' — 別の取り消し単位
  await page.waitForTimeout(650);
  ok('打った内容: xyz', await value(0) === 'xyz', await value(0));
  await undo();
  ok('1回目のCtrl+Zは直近のburst(z)だけ戻す', await value(0) === 'xy', await value(0));
  await undo();
  ok('2回目のCtrl+Zは最初のburst(xy)を戻す', await value(0) === '', await value(0));
  await redoShift();
  ok('Ctrl+Shift+Zでxyへやり直す', await value(0) === 'xy', await value(0));
  await redoY();
  ok('Ctrl+Yでxyzへやり直す', await value(0) === 'xyz', await value(0));

  console.log('\n== 2. カーソル/フォーカスは操作前の場所へ戻る ==');
  await undo(); await undo();
  let focus = await focusInfo();
  ok('取り消し後もアクティブ行へフォーカスが残る（proxyかmathfieldのどちらか）', focus.onProxy || focus.onMathfield, focus);

  console.log('\n== 3. ブロック追加をCtrl+Zで取り消す ==');
  await page.evaluate(() => window.__neoApp.newNote());
  await page.click('math-field');
  await switchLayer('latin');
  await pressCode('KeyA');
  await page.waitForTimeout(650); // 直前の入力を1単位として確定させておく
  const beforeAdd = await rowsCount();
  await pressCode('Enter'); // 新しい空blockを追加
  ok('Enterでブロックが増える', await rowsCount() === beforeAdd + 1, await rowsCount());
  await undo();
  ok('Ctrl+Zでブロック追加を取り消す', await rowsCount() === beforeAdd, await rowsCount());
  ok('取り消し後のアクティブ行は元の行(0)', await activeIndex() === 0, await activeIndex());
  ok('取り消し後も元の内容(a)を保つ', await value(0) === 'a', await value(0));
  await redoShift();
  ok('やり直すとブロック追加が戻る', await rowsCount() === beforeAdd + 1, await rowsCount());

  console.log('\n== 4. ブロック削除をCtrl+Zで取り消す ==');
  await page.evaluate(() => window.__neoApp.newNote());
  await page.click('math-field');
  await switchLayer('latin');
  await pressCode('KeyA');
  await page.waitForTimeout(650);
  await pressCode('Enter'); // 空の2番目blockを作る
  await page.waitForTimeout(650);
  const beforeDelete = await page.evaluate(() => window.__neoApp.rows.map((row) => row.mf.value));
  ok('削除前は2 block(a, 空)', JSON.stringify(beforeDelete) === JSON.stringify(['a', '']), beforeDelete);
  await pressCode('Backspace'); // 空blockのBackspace = removeEmptyRow経由でblock削除
  await page.waitForTimeout(30);
  ok('空blockのBackspaceでblockを削除する', await rowsCount() === beforeDelete.length - 1, await rowsCount());
  await undo();
  const afterUndoDelete = await page.evaluate(() => window.__neoApp.rows.map((row) => row.mf.value));
  ok('Ctrl+Zで削除したblockと内容を復元する', JSON.stringify(afterUndoDelete) === JSON.stringify(beforeDelete), afterUndoDelete);

  console.log('\n== 5. 変換候補の確定は独立した取り消し単位 ==');
  await page.evaluate(() => window.__neoApp.setInputSystem('conversion', false));
  await page.evaluate(() => window.__neoApp.newNote());
  await page.click('math-field');
  // 変換層でxを打ち、Enterで小文字xを確定（＝1つの取り消し単位）
  await switchLayer('symbol');
  await pressCode('KeyX');
  await pressCode('Enter');
  await page.waitForTimeout(650);
  const beforeConfirm = await value(0);
  ok('xを小文字で確定する', beforeConfirm === 'x', beforeConfirm);
  // 同じ変換層のreadingで積分記号を確定する（別の取り消し単位になるはず）
  for (const ch of 'INTEGRAL') await pressCode(`Key${ch}`);
  await pressCode('Enter');
  const afterConfirm = await value(0);
  ok('候補確定でxの後ろに∫が入る', afterConfirm !== beforeConfirm && afterConfirm.includes('\\int'), afterConfirm);
  await undo();
  ok('Ctrl+Zは候補確定だけを取り消しxだけ残す', await value(0) === beforeConfirm, await value(0));

  console.log('\n== 6. 設定モーダル・文章ブロックのCtrl+Zを奪わない ==');
  await page.evaluate(() => { localStorage.removeItem('neo-math.notes.v1'); window.__neoApp.setInputSystem('legacy', false); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('math-field');
  await page.click('#sidebar-toggle');
  await page.waitForTimeout(80);
  await page.click('#settings-search');
  await page.keyboard.type('abc');
  const historyBeforeSettings = await page.evaluate(() => window.__neoApp.getHistoryState());
  await pressCode('KeyZ', { ctrl: true });
  const historyAfterSettings = await page.evaluate(() => window.__neoApp.getHistoryState());
  ok('設定モーダル内のCtrl+Zはアプリの履歴を動かさない', JSON.stringify(historyBeforeSettings) === JSON.stringify(historyAfterSettings), { historyBeforeSettings, historyAfterSettings });
  await page.click('#sidebar-close');
  await page.waitForTimeout(80);

  await page.click('math-field');
  await page.click('[data-special="Text"]');
  await page.waitForTimeout(30);
  await page.keyboard.type('hi');
  const historyBeforeText = await page.evaluate(() => window.__neoApp.getHistoryState());
  await pressCode('KeyZ', { ctrl: true });
  const historyAfterText = await page.evaluate(() => window.__neoApp.getHistoryState());
  ok('文章ブロック内のCtrl+Zはアプリの履歴を動かさない', JSON.stringify(historyBeforeText) === JSON.stringify(historyAfterText), { historyBeforeText, historyAfterText });
  await pressCode('Enter'); // 文を閉じる（後片付け）

  ok('画面エラーなし', errors.length === 0, errors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) process.exit(1);
}

main();
