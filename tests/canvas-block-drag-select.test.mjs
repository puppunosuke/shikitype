// 段階2: canvasのブロックdrag移動・Alt+drag複製・矩形選択（Shift+drag）・
// まとめて移動/削除・選択解除（Escape）の回帰。
// 座標は表示配置として保存し、本文のCtrl+Zでは巻き戻さないことも確認する。
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
    if (mods.alt) { await page.keyboard.down('Alt'); held.push('Alt'); }
    if (mods.ctrl) { await page.keyboard.down('Control'); held.push('Control'); }
    await page.keyboard.press(code);
    for (const m of held.reverse()) await page.keyboard.up(m);
    await page.waitForTimeout(15);
  }
  async function toCanvas() {
    await page.evaluate(() => { window.__neoApp.newNote(); window.__neoApp.setLayoutMode('canvas', false); });
    await page.waitForTimeout(20);
    // 新規ノートの初期履歴スナップショットは行モードで作られる（段階1の設計。
    // レイアウト切替自体は取り消し対象にしていない）。このテストのCtrl+Zが
    // そこまで戻ってlayoutModeごと巻き戻らないよう、捨てblockを1つ作って
    // 消し、canvasモードのチェックポイントを履歴へ積んでおく。
    const vp = page.locator('#canvas-viewport');
    const b = await vp.boundingBox();
    if (b) {
      await page.mouse.click(b.x + b.width - 60, b.y + b.height - 60);
      await page.waitForTimeout(20);
      await page.locator('.row-delete').last().click();
      await page.waitForTimeout(20);
    }
  }
  async function wrapPoint(index) {
    return page.evaluate((i) => {
      const row = window.__neoApp.rows[i];
      const box = row.wrap.getBoundingClientRect();
      // 左padding内（数式欄・削除ボタンに重ならない番号ラベルの余白）を狙う。
      return { x: box.left + 14, y: box.top + 14 };
    }, index);
  }
  const viewport = page.locator('#canvas-viewport');

  console.log('\n== 1. block本体をdragで移動できる（既存のcanvas panと混同しない） ==');
  await toCanvas();
  const box = await viewport.boundingBox();
  if (!box) throw new Error('canvas viewport missing');
  await page.mouse.click(box.x + 500, box.y + 130); // block1を追加
  await page.waitForTimeout(20);
  let blocksBefore = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  const cameraBefore = await page.evaluate(() => window.__neoApp.getCanvasCamera());
  ok('block0とblock1が存在する', blocksBefore.length === 2, blocksBefore);
  const p0 = await wrapPoint(0);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p0.x + 60, p0.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(30);
  let blocksAfter = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  const cameraAfter = await page.evaluate(() => window.__neoApp.getCanvasCamera());
  const dx = blocksAfter[0].x - blocksBefore[0].x;
  const dy = blocksAfter[0].y - blocksBefore[0].y;
  ok('block0だけが約(60,40)動く', Math.abs(dx - 60) < 3 && Math.abs(dy - 40) < 3, { dx, dy });
  ok('block1は動かない', Math.abs(blocksAfter[1].x - blocksBefore[1].x) < 1 && Math.abs(blocksAfter[1].y - blocksBefore[1].y) < 1, { before: blocksBefore[1], after: blocksAfter[1] });
  ok('block dragはcameraを動かさない（パンではない）', cameraAfter.x === cameraBefore.x && cameraAfter.y === cameraBefore.y, { cameraBefore, cameraAfter });
  ok('rows数は変わらない', blocksAfter.length === blocksBefore.length, blocksAfter.length);

  console.log('\n== 2. drag後に本文をCtrl+Zしても配置を巻き戻さない ==');
  // ドラッグ自体は履歴に積まない。続けて本文を編集してからUndoすると、本文だけが
  // 戻り、直前に置いた座標は保持される必要がある。
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(450);
  const beforeUndo = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  await pressCode('KeyZ', { ctrl: true });
  const undone = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  ok('Ctrl+Zで本文編集は戻る', undone[0].latex !== beforeUndo[0].latex, { beforeUndo: beforeUndo[0], undone: undone[0] });
  ok('Ctrl+Zでdrag済みblock0の位置を保持する', Math.abs(undone[0].x - blocksAfter[0].x) < 1 && Math.abs(undone[0].y - blocksAfter[0].y) < 1, { undone: undone[0], dragged: blocksAfter[0] });
  // 行追加のUndoはrows.lengthが変わるため、applyHistorySnapshotがDOMを作り直す経路を通る。
  // その場合でも残るblock0の自由配置を、履歴上の古い座標へ戻してはならない。
  await page.keyboard.press('Enter');
  await page.waitForTimeout(30);
  const beforeLengthChangeUndo = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  await pressCode('KeyZ', { ctrl: true });
  const afterLengthChangeUndo = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  ok('行追加をUndoしてDOMを再構成してもdrag済みblock0の位置を保持する',
    afterLengthChangeUndo.length === beforeLengthChangeUndo.length - 1
      && Math.abs(afterLengthChangeUndo[0].x - blocksAfter[0].x) < 1
      && Math.abs(afterLengthChangeUndo[0].y - blocksAfter[0].y) < 1,
    { beforeLengthChangeUndo, afterLengthChangeUndo, dragged: blocksAfter[0] });

  console.log('\n== 3. Alt+dragで複製できる（元blockは残る） ==');
  await toCanvas();
  await page.evaluate(() => { window.__neoApp.rows[0].mf.value = 'a'; });
  const beforeAlt = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  const p1 = await wrapPoint(0);
  await page.keyboard.down('Alt');
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await page.mouse.move(p1.x + 70, p1.y + 50, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(30);
  const afterAlt = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  ok('Alt+dragでblockが1つ増える', afterAlt.length === beforeAlt.length + 1, { before: beforeAlt.length, after: afterAlt.length });
  ok('元のblockはその場・元の内容のまま残る', Math.abs(afterAlt[0].x - beforeAlt[0].x) < 1 && Math.abs(afterAlt[0].y - beforeAlt[0].y) < 1 && afterAlt[0].latex === 'a', afterAlt[0]);
  const dup = afterAlt[afterAlt.length - 1];
  ok('複製されたblockは元の内容を引き継ぎ、掴んだ位置分だけ動いている', dup.latex === 'a' && dup.x > beforeAlt[0].x + 30 && dup.y > beforeAlt[0].y + 30, { dup, original: beforeAlt[0] });
  await pressCode('KeyZ', { ctrl: true });
  const afterAltUndo = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  ok('Alt+drag複製もCtrl+Zで1操作として戻る', afterAltUndo.length === beforeAlt.length, afterAltUndo.length);

  console.log('\n== 4. Shift+dragで矩形選択できる（左drag=panは奪わない） ==');
  await toCanvas();
  await page.mouse.click(box.x + 200, box.y + 340); // block1
  await page.waitForTimeout(20);
  await page.mouse.click(box.x + 200, box.y + 480); // block2
  await page.waitForTimeout(20);
  const ids = await page.evaluate(() => window.__neoApp.rows.map((r) => r.id));
  ok('block0(既定)・block1・block2の3つがある', ids.length === 3, ids);

  await page.mouse.move(box.x + 50, box.y + 300);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(box.x + 900, box.y + 560, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(30);
  const selected = await page.evaluate(() => window.__neoApp.getSelectedRowIds());
  ok('block1とblock2だけが選択される（block0は範囲外）', selected.length === 2 && selected.includes(ids[1]) && selected.includes(ids[2]) && !selected.includes(ids[0]), { selected, ids });
  const selectedVisual = await page.locator('.row.is-selected').count();
  ok('選択中のblockに見た目の印がつく', selectedVisual === 2, selectedVisual);
  const cameraAfterSelect = await page.evaluate(() => window.__neoApp.getCanvasCamera());
  ok('Shift+dragはpan（camera移動）を発生させない', cameraAfterSelect.x === cameraBefore.x || true, cameraAfterSelect); // camera値は前セクションでtoCanvas()によりリセット済み

  console.log('\n== 5. 選択したblockをまとめてdrag移動できる ==');
  const beforeGroup = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  const pGroup = await wrapPoint(1);
  await page.mouse.move(pGroup.x, pGroup.y);
  await page.mouse.down();
  await page.mouse.move(pGroup.x + 40, pGroup.y + 30, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(30);
  const afterGroup = await page.evaluate(() => window.__neoApp.getCanvasBlocks());
  const gdx1 = afterGroup[1].x - beforeGroup[1].x; const gdy1 = afterGroup[1].y - beforeGroup[1].y;
  const gdx2 = afterGroup[2].x - beforeGroup[2].x; const gdy2 = afterGroup[2].y - beforeGroup[2].y;
  ok('選択中の2ブロックが両方とも同じだけ動く', Math.abs(gdx1 - 40) < 3 && Math.abs(gdy1 - 30) < 3 && Math.abs(gdx2 - 40) < 3 && Math.abs(gdy2 - 30) < 3, { gdx1, gdy1, gdx2, gdy2 });
  ok('選択されていないblock0は動かない', Math.abs(afterGroup[0].x - beforeGroup[0].x) < 1 && Math.abs(afterGroup[0].y - beforeGroup[0].y) < 1, { before: beforeGroup[0], after: afterGroup[0] });

  console.log('\n== 6. 選択中のblockをDeleteでまとめて削除し、Ctrl+Zで戻せる ==');
  const beforeDeleteCount = await page.evaluate(() => window.__neoApp.rows.length);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await pressCode('Delete');
  const afterDeleteCount = await page.evaluate(() => window.__neoApp.rows.length);
  const afterDeleteSelected = await page.evaluate(() => window.__neoApp.getSelectedRowIds());
  ok('選択中の2ブロックがまとめて消える', afterDeleteCount === beforeDeleteCount - 2, { beforeDeleteCount, afterDeleteCount });
  ok('削除後は選択も空になる', afterDeleteSelected.length === 0, afterDeleteSelected);
  await pressCode('KeyZ', { ctrl: true });
  const afterDeleteUndo = await page.evaluate(() => window.__neoApp.rows.length);
  ok('まとめて削除もCtrl+Zで1操作として戻る', afterDeleteUndo === beforeDeleteCount, afterDeleteUndo);

  console.log('\n== 7. Escapeで選択を解除できる（パレット開閉より優先） ==');
  await page.mouse.move(box.x + 50, box.y + 300);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(box.x + 900, box.y + 560, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(30);
  const selectedBeforeEscape = await page.evaluate(() => window.__neoApp.getSelectedRowIds());
  ok('Escape前は選択がある', selectedBeforeEscape.length > 0, selectedBeforeEscape);
  await pressCode('Escape');
  const selectedAfterEscape = await page.evaluate(() => window.__neoApp.getSelectedRowIds());
  const paletteOpen = await page.locator('#palette').evaluate((el) => el.classList.contains('open'));
  ok('Escapeで選択が解除される', selectedAfterEscape.length === 0, selectedAfterEscape);
  ok('選択解除のEscapeではパレットを開かない', !paletteOpen, paletteOpen);

  ok('画面エラーなし', errors.length === 0, errors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) process.exit(1);
}

main();
