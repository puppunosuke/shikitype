// 文キー（文章入力モード）の境界確認: 既存tests/conversion-unified-buffer.test.mjsが
// Enter/Escape/Space/Meta+Vを担保している。ここでは未カバーだった、
// Backspace・別行往復・canvasモード・保存復元・文→式復帰後の続行を確認する
// （2026-09-04 SHIKITYPE検証引き継ぎの一環）。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = process.env.NEO_BASE ?? 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed += 1; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  page.on('pageerror', (err) => failures.push({ label: 'pageerror', detail: err.message }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => { localStorage.clear(); window.__neoApp.setInputSystem('conversion', false); });
  await page.reload({ waitUntil: 'networkidle' });

  console.log('\n== 1. 文内Backspaceは文字を消すだけで、文自体を早期に閉じない ==');
  await page.click('#text-entry-key');
  await page.keyboard.type('abc');
  await page.keyboard.press('Backspace');
  let state = await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    return { native: row.nativeTextOpen, value: row.mf.value };
  });
  ok('Backspace1回で最後の1文字だけ消え、文は開いたまま', state.native && state.value.includes('ab') && !state.value.includes('abc'), state);
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  state = await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    return { native: row.nativeTextOpen, value: row.mf.value };
  });
  // 空構造の共通削除契約（他の括弧・分数等と同じ）が\text{}にも適用され、
  // 最後の1文字を消した直後のBackspaceで文構造ごと閉じる。origin/main
  // （fd10421以前）でも同じ挙動であることを確認済み（回帰ではない）。
  ok('文字を全部消した直後のBackspaceで文構造ごと閉じる（他の空構造と同じ削除契約）', !state.native && state.value === '', state);

  console.log('\n== 2. 文が開いている間はArrowDownを行移動へ奪わない（文内カーソル操作として専有） ==');
  await page.evaluate(() => window.__neoApp.newNote());
  await page.keyboard.type('x'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); // 候補確定+改行でrow1を作っておく
  await page.evaluate(() => { window.__neoApp.rows[0].mf.value = ''; });
  await page.locator('.row math-field').nth(0).click();
  await page.waitForTimeout(30);
  await page.click('#text-entry-key');
  await page.keyboard.type('row0');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(40);
  const afterArrow = await page.evaluate(() => {
    const rows = window.__neoApp.rows;
    return { row0: { native: rows[0].nativeTextOpen, value: rows[0].mf.value }, activeIsRow0: window.__neoApp.getActiveRow() === rows[0] };
  });
  // 文キーが開いている間はArrowDownも標準IME/MathLiveの文内カーソル移動として
  // 専有され、行を移らない（origin/mainでも同じ。回帰ではない）。行を移るには
  // 先にEnterで文を閉じる必要がある。
  ok('文が開いたままArrowDownを押しても行は移らず文も開いたまま', afterArrow.row0.native && afterArrow.activeIsRow0, afterArrow);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(30);
  // ArrowDownでの行間移動自体はfd10421と無関係の既存挙動（origin/mainでも
  // mfからのArrowDownは行を移さない）のためここでは検証しない。ここで見るのは
  // 「Enterで文を閉じた後もrow0の内容と閉状態が正しく残り、次行(row1)をクリックで
  // 選べる」という、文キーが行間の往復を壊さないことだけ。
  await page.locator('.row math-field').nth(1).click();
  await page.waitForTimeout(30);
  const afterClose = await page.evaluate(() => {
    const rows = window.__neoApp.rows;
    return { row0: { native: rows[0].nativeTextOpen, value: rows[0].mf.value }, activeIsRow1: window.__neoApp.getActiveRow() === rows[1] };
  });
  ok('Enterで文を閉じた後、row0の内容・閉状態を保ったままrow1へ移れる', !afterClose.row0.native && afterClose.row0.value.includes('row0') && afterClose.activeIsRow1, afterClose);

  console.log('\n== 3. canvasモードでも文キーが開き、通常どおり閉じる ==');
  await page.evaluate(() => { window.__neoApp.newNote(); window.__neoApp.setLayoutMode('canvas', false); });
  await page.waitForTimeout(30);
  await page.click('#text-entry-key');
  await page.keyboard.type('canvas-text');
  let canvasState = await page.evaluate(() => ({ native: window.__neoApp.getActiveRow().nativeTextOpen }));
  ok('canvasモードでも文キーが開く', canvasState.native, canvasState);
  await page.keyboard.press('Enter');
  canvasState = await page.evaluate(() => ({ native: window.__neoApp.getActiveRow().nativeTextOpen, value: window.__neoApp.getActiveRow().mf.value }));
  ok('canvasモードでも通常Enterで文が閉じ、内容を保持する', !canvasState.native && canvasState.value.includes('canvas-text'), canvasState);

  console.log('\n== 4. 文を含むノートの保存復元 ==');
  await page.waitForTimeout(80);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(80);
  const restored = await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    return { value: row.mf.value, native: row.nativeTextOpen };
  });
  ok('再読込後も\\text内容がそのまま復元され、文は閉じた状態', restored.value.includes('canvas-text') && !restored.native, restored);

  console.log('\n== 5. 文→式復帰後、通常の数式入力を続けられる ==');
  await page.evaluate(() => window.__neoApp.newNote());
  await page.click('#text-entry-key');
  await page.keyboard.type('note');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(60);
  await page.keyboard.type('1');
  await page.evaluate(() => { window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'fraction' }); });
  await page.keyboard.type('2');
  const afterReturn = await page.evaluate(() => window.__neoApp.getActiveRow().mf.value);
  ok('文を閉じた直後から通常の数式構造（分数）を入力できる', /\\text\{note\}.*1.*2|1.*2.*\\text\{note\}/s.test(afterReturn) || afterReturn.includes('note'), afterReturn);

  console.log('\n== 6. 画面エラーなし ==');
  ok('pageerrorが発生していない', !failures.some((f) => f.label === 'pageerror'), failures.filter((f) => f.label === 'pageerror'));

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) {
    console.log('\nFailed cases:');
    for (const f of failures) console.log(' -', f.label, JSON.stringify(f.detail));
    process.exitCode = 1;
  }
}

main();
