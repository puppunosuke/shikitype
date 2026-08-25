// 段階2: ブロック単位のコピー・貼り付け（Ctrl+C / Ctrl+V、内部クリップボード）。
// 行モード・canvasモード双方、canvasでの複数選択コピー、貼り付けの重ならない
// オフセット、1操作としてのCtrl+Z、そして「一度もブロックコピーを使っていない
// 利用者はCtrl+Vの意味を変えない」フォールバックを確認する。
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

  console.log('\n== 0. まだブロックコピーを使っていない状態のCtrl+Vは何も増やさない ==');
  await page.click('math-field');
  const beforeFallback = await page.evaluate(() => window.__neoApp.rows.length);
  ok('初期状態のblockClipboardは空', await page.evaluate(() => window.__neoApp.getBlockClipboard()) === null);
  await pressCode('KeyV', { ctrl: true });
  await page.waitForTimeout(30);
  const afterFallback = await page.evaluate(() => window.__neoApp.rows.length);
  ok('blockClipboardが空のCtrl+Vはブロックを増やさない（既存のUnicode貼り付け経路へ譲る）', afterFallback === beforeFallback, { beforeFallback, afterFallback });

  console.log('\n== 1. 行モード: Ctrl+C/Ctrl+Vで現在行の直下に複製される ==');
  await page.evaluate(() => { window.__neoApp.newNote(); });
  await page.click('math-field');
  await page.evaluate(() => { window.__neoApp.rows[0].mf.value = 'k'; window.__neoApp.rows[0].mf.position = window.__neoApp.rows[0].mf.lastOffset; });
  const rowsBefore = await page.evaluate(() => window.__neoApp.rows.length);
  await pressCode('KeyC', { ctrl: true });
  const clip = await page.evaluate(() => window.__neoApp.getBlockClipboard());
  ok('Ctrl+Cで現在行をブロッククリップボードへコピーする', clip?.length === 1 && clip[0].latex === 'k', clip);
  await pressCode('KeyV', { ctrl: true });
  const afterPasteRows = await page.evaluate(() => window.__neoApp.rows.map((r) => r.mf.value));
  const activeAfterPaste = await page.evaluate(() => window.__neoApp.rows.indexOf(window.__neoApp.getActiveRow()));
  ok('Ctrl+Vで現在行の直下へ複製した行が増える', afterPasteRows.length === rowsBefore + 1 && afterPasteRows[1] === 'k', afterPasteRows);
  ok('貼り付けた行へ入力先が移る', activeAfterPaste === 1, activeAfterPaste);
  await pressCode('KeyZ', { ctrl: true });
  const afterUndoRows = await page.evaluate(() => window.__neoApp.rows.length);
  ok('行モードの貼り付けもCtrl+Zで1操作として戻る', afterUndoRows === rowsBefore, afterUndoRows);

  console.log('\n== 2. canvasモード: 単体blockのCtrl+C/Ctrl+Vは重ならない位置へ複製される ==');
  await page.evaluate(() => { window.__neoApp.newNote(); window.__neoApp.setLayoutMode('canvas', false); });
  await page.click('math-field');
  await page.evaluate(() => { window.__neoApp.rows[0].mf.value = 'q'; });
  const original = (await page.evaluate(() => window.__neoApp.getCanvasBlocks()))[0];
  await pressCode('KeyC', { ctrl: true });
  await pressCode('KeyV', { ctrl: true });
  let blocks = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  ok('1回目の貼り付けでblockが1つ増える', blocks.length === 2, blocks);
  const firstPaste = blocks[1];
  ok('複製内容は元と同じ', firstPaste.latex === 'q', firstPaste);
  ok('元の位置とは重ならない位置にずらして置かれる', firstPaste.x !== original.x || firstPaste.y !== original.y, { original, firstPaste });
  await pressCode('KeyV', { ctrl: true });
  blocks = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  const secondPaste = blocks[2];
  ok('2回目の貼り付けはさらに追加で1つ増える', blocks.length === 3, blocks.length);
  ok('連続貼り付けは1回目の貼り付け位置とも重ならない', secondPaste.x !== firstPaste.x || secondPaste.y !== firstPaste.y, { firstPaste, secondPaste });

  console.log('\n== 3. canvasモード: 矩形選択した複数blockをまとめてコピー・貼り付けできる ==');
  await page.evaluate(() => { window.__neoApp.newNote(); window.__neoApp.setLayoutMode('canvas', false); });
  const viewport = page.locator('#canvas-viewport');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('canvas viewport missing');
  await page.mouse.click(box.x + 200, box.y + 340); // block1
  await page.waitForTimeout(20);
  await page.mouse.click(box.x + 200, box.y + 480); // block2
  await page.waitForTimeout(20);
  await page.evaluate(() => {
    window.__neoApp.rows[0].mf.value = 'p';
    window.__neoApp.rows[1].mf.value = 'q';
    window.__neoApp.rows[2].mf.value = 'r';
  });
  await page.mouse.move(box.x + 50, box.y + 300);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(box.x + 900, box.y + 560, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(30);
  const selected = await page.evaluate(() => window.__neoApp.getSelectedRowIds());
  ok('block1(q)とblock2(r)が選択されている', selected.length === 2, selected);

  const beforeMultiRows = await page.evaluate(() => window.__neoApp.rows.length);
  const beforeMultiBlocks = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  await pressCode('KeyC', { ctrl: true });
  const multiClip = await page.evaluate(() => window.__neoApp.getBlockClipboard());
  ok('選択中の2ブロックをまとめてコピーする', multiClip?.length === 2 && multiClip.map((c) => c.latex).join(',') === 'q,r', multiClip);

  await pressCode('KeyV', { ctrl: true });
  const afterMultiRows = await page.evaluate(() => window.__neoApp.rows.length);
  const afterMultiBlocks = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  ok('まとめて貼り付けるとその分だけblockが増える', afterMultiRows === beforeMultiRows + 2, { beforeMultiRows, afterMultiRows });
  const pastedLatex = afterMultiBlocks.slice(beforeMultiBlocks.length).map((b) => b.latex).sort();
  ok('貼り付けたblockはコピー元の内容を保つ', JSON.stringify(pastedLatex) === JSON.stringify(['q', 'r']), pastedLatex);
  const pastedSelected = await page.evaluate(() => window.__neoApp.getSelectedRowIds());
  ok('貼り付け直後は新しいblockの方が選択状態になる', pastedSelected.length === 2, pastedSelected);

  console.log('\n== 4. まとめて貼り付けもCtrl+Zで1操作として戻る ==');
  await pressCode('KeyZ', { ctrl: true });
  const afterUndoMulti = await page.evaluate(() => window.__neoApp.rows.length);
  ok('複数blockの貼り付けも1回のCtrl+Zで戻る', afterUndoMulti === beforeMultiRows, { beforeMultiRows, afterUndoMulti });

  ok('画面エラーなし', errors.length === 0, errors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) process.exit(1);
}

main();
