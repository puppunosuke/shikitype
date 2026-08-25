import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(BASE, { waitUntil: 'networkidle' });

await page.click('#sidebar-toggle');
ok('設定から行モードとキャンバスを切り替えられる', await page.locator('.layout-mode-choice').count() === 2 && await page.getAttribute('.layout-mode-choice[data-layout-mode="rows"]', 'aria-pressed') === 'true');
await page.click('.layout-mode-choice[data-layout-mode="canvas"]');
await page.click('#sidebar-close');
ok('新規ノートの既定である行モードから、明示操作でキャンバスへ切り替わる', await page.evaluate(() => window.__neoApp.getLayoutMode()) === 'canvas' && await page.locator('#editor-sheet').evaluate((el) => el.classList.contains('canvas-mode')));

const viewport = page.locator('#canvas-viewport');
const viewportBox = await viewport.boundingBox();
if (!viewportBox) throw new Error('canvas viewport missing');
const beforeCreate = await page.evaluate(() => window.__neoApp.rows.length);
await page.mouse.click(viewportBox.x + Math.min(viewportBox.width - 40, 900), viewportBox.y + Math.min(viewportBox.height - 40, 500));
await page.waitForTimeout(40);
const created = await page.evaluate(() => ({ count: window.__neoApp.rows.length, active: window.__neoApp.rows.indexOf(window.__neoApp.getActiveRow()), blocks: window.__neoApp.getCanvasBlocks() }));
ok('空白クリックでその場に数式ブロックを作り、入力先を移す', created.count === beforeCreate + 1 && created.active === created.count - 1 && created.blocks.at(-1).x > 0 && created.blocks.at(-1).y > 0, created);

const beforeLeftDrag = await page.evaluate(() => ({ rows: window.__neoApp.rows.length, camera: window.__neoApp.getCanvasCamera() }));
await page.mouse.move(viewportBox.x + 700, viewportBox.y + 260);
await page.mouse.down();
await page.mouse.move(viewportBox.x + 780, viewportBox.y + 330, { steps: 2 });
await page.mouse.up();
const afterLeftDrag = await page.evaluate(() => ({ rows: window.__neoApp.rows.length, camera: window.__neoApp.getCanvasCamera() }));
ok('空白の左ドラッグはパンし、blockを増やさない', afterLeftDrag.rows === beforeLeftDrag.rows && (afterLeftDrag.camera.x !== beforeLeftDrag.camera.x || afterLeftDrag.camera.y !== beforeLeftDrag.camera.y), { beforeLeftDrag, afterLeftDrag });

const touchTap = await page.evaluate(() => {
  const viewport = document.getElementById('canvas-viewport'); const rect = viewport.getBoundingClientRect();
  const before = window.__neoApp.rows.length;
  const send = (type) => viewport.dispatchEvent(new PointerEvent(type, { pointerId: 61, pointerType: 'touch', clientX: rect.left + rect.width - 55, clientY: rect.top + rect.height - 55, bubbles: true, cancelable: true }));
  send('pointerdown'); send('pointerup');
  return { before, after: window.__neoApp.rows.length, active: window.__neoApp.rows.indexOf(window.__neoApp.getActiveRow()) };
});
ok('空白の単独タップでもその位置に入力ブロックを作る', touchTap.after === touchTap.before + 1 && touchTap.active === touchTap.after - 1, touchTap);

const oneFingerPan = await page.evaluate(() => {
  const viewport = document.getElementById('canvas-viewport'); const rect = viewport.getBoundingClientRect();
  const send = (type, x, y) => viewport.dispatchEvent(new PointerEvent(type, { pointerId: 62, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const before = window.__neoApp.getCanvasCamera(); const rows = window.__neoApp.rows.length;
  send('pointerdown', rect.left + 600, rect.top + 260);
  send('pointermove', rect.left + 690, rect.top + 315);
  send('pointerup', rect.left + 690, rect.top + 315);
  return { before, after: window.__neoApp.getCanvasCamera(), rowsBefore: rows, rowsAfter: window.__neoApp.rows.length };
});
ok('一本指ドラッグはキャンバスを移動し、終了時にブロックを増やさない', (oneFingerPan.after.x !== oneFingerPan.before.x || oneFingerPan.after.y !== oneFingerPan.before.y) && oneFingerPan.rowsBefore === oneFingerPan.rowsAfter, oneFingerPan);

const rowsBeforePan = await page.evaluate(() => window.__neoApp.rows.length);
const cameraBeforePan = await page.evaluate(() => window.__neoApp.getCanvasCamera());
await page.mouse.move(viewportBox.x + 640, viewportBox.y + 300);
await page.mouse.down({ button: 'right' });
await page.mouse.move(viewportBox.x + 760, viewportBox.y + 370, { steps: 3 });
await page.mouse.up({ button: 'right' });
const afterRightPan = await page.evaluate(() => ({ count: window.__neoApp.rows.length, camera: window.__neoApp.getCanvasCamera() }));
ok('右ドラッグはパンもblock生成も行わず、通常操作として残る', afterRightPan.count === rowsBeforePan && afterRightPan.camera.x === cameraBeforePan.x && afterRightPan.camera.y === cameraBeforePan.y, { cameraBeforePan, afterRightPan });

const contextMenu = await page.evaluate(() => {
  const viewport = document.getElementById('canvas-viewport');
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  const allowed = viewport.dispatchEvent(event);
  return { allowed, defaultPrevented: event.defaultPrevented };
});
ok('canvas空白のcontextmenuは通常どおり抑止しない', contextMenu.allowed && !contextMenu.defaultPrevented, contextMenu);

const beforeWheel = await page.evaluate(() => ({ camera: window.__neoApp.getCanvasCamera(), scrollY: window.scrollY }));
await page.mouse.move(viewportBox.x + 470, viewportBox.y + 270);
await page.mouse.wheel(0, -420);
await page.waitForTimeout(30);
const afterWheel = await page.evaluate(() => ({ camera: window.__neoApp.getCanvasCamera(), scrollY: window.scrollY }));
ok('ホイールはポインタ中心で拡大し、ページ全体をスクロールしない', afterWheel.camera.zoom > beforeWheel.camera.zoom && afterWheel.scrollY === beforeWheel.scrollY, { beforeWheel, afterWheel });

const touchGesture = await page.evaluate(() => {
  const viewport = document.getElementById('canvas-viewport');
  const send = (type, id, x, y) => viewport.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const rect = viewport.getBoundingClientRect();
  const before = window.__neoApp.getCanvasCamera(); const rows = window.__neoApp.rows.length;
  send('pointerdown', 71, rect.left + 180, rect.top + 180);
  send('pointerdown', 72, rect.left + 300, rect.top + 180);
  send('pointermove', 71, rect.left + 150, rect.top + 150);
  send('pointermove', 72, rect.left + 360, rect.top + 210);
  send('pointerup', 71, rect.left + 150, rect.top + 150);
  send('pointerup', 72, rect.left + 360, rect.top + 210);
  return { before, after: window.__neoApp.getCanvasCamera(), rowsBefore: rows, rowsAfter: window.__neoApp.rows.length };
});
ok('二本指は拡大と移動をまとめて扱い、ブロックを増やさない', touchGesture.after.zoom > touchGesture.before.zoom && touchGesture.rowsBefore === touchGesture.rowsAfter, touchGesture);

const beforeDelete = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  row.mf.value = 'z'; row.mf.position = row.mf.lastOffset;
  return { count: window.__neoApp.rows.length, camera: window.__neoApp.getCanvasCamera() };
});
await page.mouse.click(viewportBox.x + 430, viewportBox.y + 240);
await page.waitForTimeout(20);
await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  row.mf.value = 'z'; row.mf.position = row.mf.lastOffset;
});
const deleteControl = page.locator('.row-delete').last();
const deleteSize = await deleteControl.evaluate((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }));
await deleteControl.click();
await page.waitForTimeout(30);
const afterDelete = await page.evaluate(() => ({ count: window.__neoApp.rows.length, camera: window.__neoApp.getCanvasCamera() }));
ok('canvas block右上の×は44pxのhit領域でそのblockを削除しパンしない', deleteSize.width >= 44 && deleteSize.height >= 44 && afterDelete.count === beforeDelete.count && afterDelete.camera.x === beforeDelete.camera.x && afterDelete.camera.y === beforeDelete.camera.y, { beforeDelete, deleteSize, afterDelete });

await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  row.mf.value = 'x^2'; row.mf.position = row.mf.lastOffset;
  window.__neoApp.saveNote();
});
await page.waitForTimeout(30);
let saved = await page.evaluate(() => {
  const store = window.__neoApp.getNotes(); const note = store.notes.find((item) => item.id === store.activeId);
  return { note, camera: window.__neoApp.getCanvasCamera(), raw: localStorage.getItem('neo-math.notes.v1') };
});
ok('キャンバスの配置とカメラをローカルノートへ保存する', saved.note?.layout?.mode === 'canvas' && saved.note.layout.blocks.length === afterDelete.count && saved.note.layout.camera.zoom === saved.camera.zoom, saved);
await page.mouse.move(viewportBox.x + 440, viewportBox.y + 240);
await page.mouse.wheel(0, 220);
await page.waitForTimeout(520);
const cameraOnlySave = await page.evaluate(() => {
  const store = window.__neoApp.getNotes(); const note = store.notes.find((item) => item.id === store.activeId);
  return { note, camera: window.__neoApp.getCanvasCamera(), rowCount: window.__neoApp.rows.length };
});
ok('既存ノートはカメラだけを動かした場合も自動保存する', cameraOnlySave.note.layout.camera.zoom === cameraOnlySave.camera.zoom && cameraOnlySave.note.layout.camera.zoom !== saved.note.layout.camera.zoom && cameraOnlySave.rowCount === afterDelete.count, cameraOnlySave);
saved = cameraOnlySave;
await page.reload({ waitUntil: 'networkidle' });
const restored = await page.evaluate(() => ({ mode: window.__neoApp.getLayoutMode(), camera: window.__neoApp.getCanvasCamera(), blocks: window.__neoApp.getCanvasBlocks(), active: window.__neoApp.getActiveRow().mf.value, raw: localStorage.getItem('neo-math.notes.v1'), store: window.__neoApp.getNotes() }));
ok('再読込後もキャンバス、カメラ、数式ブロックを復元する', restored.mode === 'canvas' && restored.camera.zoom === saved.camera.zoom && restored.blocks.length === afterDelete.count && restored.blocks.some((block) => block.latex.includes('x^2')), restored);

await page.evaluate(() => window.__neoApp.setInputSystem('conversion', false));
await page.keyboard.type('shi');
const candidateGeometry = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  const field = row.mf.getBoundingClientRect(); const tray = row.conversion.shell.getBoundingClientRect();
  return { below: tray.top >= field.bottom - 1, sameRow: row.conversion.shell.closest('.row') === row.wrap };
});
ok('変換候補はキャンバス上でも対象ブロックの直下へ追従する', candidateGeometry.below && candidateGeometry.sameRow, candidateGeometry);

const canvasCaret = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow(); const block = row.wrap.getBoundingClientRect(); const caret = row.caret.getBoundingClientRect();
  return { caret, block, inBlock: caret.left >= block.left && caret.left <= block.right && caret.top >= block.top && caret.top <= block.bottom, nonOrigin: caret.left > 1 || caret.top > 1, overlay: row.caret.parentElement === document.body };
});
ok('canvasの新規/既存blockでも変換caretはbody overlayでblock内を追従する', canvasCaret.inBlock && canvasCaret.nonOrigin && canvasCaret.overlay, canvasCaret);

await page.mouse.move(viewportBox.x + 470, viewportBox.y + 270); await page.mouse.wheel(0, -180); await page.waitForTimeout(40);
const zoomedCaret = await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); const block = row.wrap.getBoundingClientRect(); const caret = row.caret.getBoundingClientRect(); return { inBlock: caret.left >= block.left && caret.left <= block.right && caret.top >= block.top && caret.top <= block.bottom, nonOrigin: caret.left > 1 || caret.top > 1 }; });
ok('canvas zoom後も変換caretは原点へ飛ばず対象blockに残る', zoomedCaret.inBlock && zoomedCaret.nonOrigin, zoomedCaret);

await page.mouse.click(viewportBox.x + 260, viewportBox.y + 390); await page.waitForTimeout(80);
const secondCanvasCaret = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow(); const block = row.wrap.getBoundingClientRect(); const visible = [...document.querySelectorAll('.conversion-caret:not([hidden])')].map((caret) => caret.getBoundingClientRect().toJSON());
  return { count: visible.length, inActiveBlock: visible.length === 1 && visible[0].left >= block.left && visible[0].left <= block.right && visible[0].top >= block.top && visible[0].top <= block.bottom, nonOrigin: visible[0]?.left > 1 || visible[0]?.top > 1 };
});
ok('canvasで2個目blockを作っても可視caretは新しい入力先の1本だけ', secondCanvasCaret.count === 1 && secondCanvasCaret.inActiveBlock && secondCanvasCaret.nonOrigin, secondCanvasCaret);

await page.setViewportSize({ width: 360, height: 760 });
await page.waitForTimeout(30);
const narrowDelete = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  const button = row.wrap.querySelector('.row-delete');
  const field = row.mf.getBoundingClientRect(); const control = button.getBoundingClientRect(); const wrap = row.wrap.getBoundingClientRect();
  return { width: control.width, height: control.height, inside: control.left >= wrap.left && control.right <= wrap.right && control.top >= wrap.top && control.bottom <= wrap.bottom, separated: field.right <= control.left };
});
ok('360pxでも×は44pxの操作領域で数式欄と重ならない', narrowDelete.width >= 44 && narrowDelete.height >= 44 && narrowDelete.inside && narrowDelete.separated, narrowDelete);

while (await page.locator('.row-delete').count()) {
  await page.locator('.row-delete').last().click();
  await page.waitForTimeout(20);
}
await page.evaluate(() => window.__neoApp.saveNote());
await page.waitForTimeout(30);
const emptyCanvasSaved = await page.evaluate(() => {
  const store = window.__neoApp.getNotes(); const note = store.notes.find((item) => item.id === store.activeId);
  return { rows: window.__neoApp.rows.length, note };
});
await page.reload({ waitUntil: 'networkidle' });
const emptyCanvasRestored = await page.evaluate(() => ({ mode: window.__neoApp.getLayoutMode(), rows: window.__neoApp.rows.length, blocks: window.__neoApp.getCanvasBlocks() }));
ok('既存canvasの最後の×削除は0 blockとして保存・再読込できる', emptyCanvasSaved.rows === 0 && emptyCanvasSaved.note?.rows.length === 0 && emptyCanvasSaved.note?.layout?.blocks.length === 0 && emptyCanvasRestored.mode === 'canvas' && emptyCanvasRestored.rows === 0 && emptyCanvasRestored.blocks.length === 0, { emptyCanvasSaved, emptyCanvasRestored });
ok('画面エラーなし', errors.length === 0, errors);

await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
