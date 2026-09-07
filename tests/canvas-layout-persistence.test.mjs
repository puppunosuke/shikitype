import { chromium } from '../spike/node_modules/playwright/index.mjs';

const base = process.env.NEO_BASE ?? 'http://localhost:8893/app.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const failures = [];
function ok(label, value, detail = value) {
  if (value) console.log(`  OK  ${label}`);
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

await page.goto(base, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

// C4: canvasで自由配置したノートを行表示で離れても、元の位置とcameraを残す。
const state = await page.evaluate(() => {
  window.__neoApp.newNote();
  window.__neoApp.setLayoutMode('canvas', false);
  const row = window.__neoApp.getActiveRow();
  row.mf.value = 'x';
  row.wrap.dataset.canvasX = '426'; row.wrap.dataset.canvasY = '318';
  row.canvasFlow = false;
  const viewport = document.getElementById('canvas-viewport');
  const rect = viewport.getBoundingClientRect();
  viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.left + 180, clientY: rect.top + 140, deltaY: -250 }));
  viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 71, button: 0, clientX: rect.left + 12, clientY: rect.top + 12 }));
  viewport.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 71, button: 0, clientX: rect.left + 72, clientY: rect.top + 52 }));
  viewport.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 71, button: 0, clientX: rect.left + 72, clientY: rect.top + 52 }));
  const cameraBefore = window.__neoApp.getCanvasCamera();
  window.__neoApp.saveNote();
  const first = window.__neoApp.getNotes().activeId;
  window.__neoApp.setLayoutMode('rows');
  window.__neoApp.saveNote();
  window.__neoApp.newNote();
  window.__neoApp.getActiveRow().mf.value = 'y'; window.__neoApp.saveNote();
  const second = window.__neoApp.getNotes().activeId;
  window.__neoApp.loadNote(first, false);
  const restoredRows = window.__neoApp.rows.map((item) => ({ x: +item.wrap.dataset.canvasX, y: +item.wrap.dataset.canvasY, flow: item.canvasFlow }));
  const camera = window.__neoApp.getCanvasCamera();
  window.__neoApp.setLayoutMode('canvas', false);
  return { first, second, mode: window.__neoApp.getLayoutMode(), restoredRows, cameraBefore, camera };
});
ok('行表示を挟んだノート変更後もcanvas座標・自由配置・cameraを復元する', state.mode === 'canvas'
  && state.restoredRows[0]?.x === 426 && state.restoredRows[0]?.y === 318 && state.restoredRows[0]?.flow === false
  && JSON.stringify(state.camera) === JSON.stringify(state.cameraBefore), state);

const legacyCanvas = await page.evaluate(() => {
  window.__neoApp.newNote(); window.__neoApp.setLayoutMode('canvas', false);
  window.__neoApp.getActiveRow().mf.value = 'legacy-canvas';
  window.__neoApp.saveNote();
  const note = window.__neoApp.getNotes().notes.find((item) => item.id === window.__neoApp.getNotes().activeId);
  // 旧クライアントはcanvas modeでlayout.blocksを本文としてロードする。保存済み
  // payloadがその経路に必要なlatexを残すことを確認する。
  return { mode: note.layout.mode, blocks: note.layout.blocks.map((block) => ({ latex: block.latex, x: block.x, y: block.y })) };
});
ok('canvas表示で保存するlayout.blocksは旧クライアント用の本文も残す', legacyCanvas.mode === 'canvas' && legacyCanvas.blocks.some((block) => block.latex === 'legacy-canvas'), legacyCanvas);

// C1: pan/zoomを同時に使っても、変換中の表示caretは入力中blockの実画面内に残る。
await page.evaluate(() => {
  window.__neoApp.setInputSystem('conversion', false);
  const row = window.__neoApp.getActiveRow(); row.inputProxy.focus();
});
await page.keyboard.press('KeyX');
await page.waitForTimeout(80);
const caret = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  const field = row.mf.getBoundingClientRect(); const mark = row.caret.getBoundingClientRect();
  return { visible: !row.caret.hidden, field: { left: field.left, right: field.right, top: field.top, bottom: field.bottom }, mark: { left: mark.left, top: mark.top, bottom: mark.bottom } };
});
ok('zoom/pan後も変換caretは数式block内を指す', caret.visible && caret.mark.left >= caret.field.left - 3 && caret.mark.left <= caret.field.right + 3 && caret.mark.top >= caret.field.top - 5 && caret.mark.bottom <= caret.field.bottom + 5, caret);

// C3/F1/D1: headerから切り替え、内容量に合う設定と360pxの一行操作を確認する。
await page.locator('.header-layout-choice[data-layout-mode="rows"]').click();
ok('ヘッダーの行/キャンバス切替で表示モードを直接変更できる', await page.evaluate(() => window.__neoApp.getLayoutMode() === 'rows'));
await page.click('#sidebar-toggle');
const settings = await page.evaluate(() => {
  const dialog = document.getElementById('sidebar').getBoundingClientRect();
  const content = document.getElementById('settings-content').getBoundingClientRect();
  const panel = document.getElementById('settings-panel-basic').getBoundingClientRect();
  return { dialog: { height: dialog.height }, content: { height: content.height }, panel: { bottom: panel.bottom }, contentBottom: content.bottom };
});
ok('基本設定は固定760pxではなく内容量に合わせる', settings.dialog.height < 620 && settings.contentBottom - settings.panel.bottom < 80, settings);
await page.click('#sidebar-close');
await page.setViewportSize({ width: 360, height: 800 });
const mobile = await page.evaluate(() => ({
  textLabelsHidden: [...document.querySelectorAll('#note-actions > button > span:last-child')].every((node) => getComputedStyle(node).display === 'none'),
  railFits: document.getElementById('theme-sidebar').scrollWidth <= innerWidth,
  headerFits: document.getElementById('top-bar').scrollWidth <= innerWidth,
}));
ok('360pxでは上部ノート操作を一行のアイコンへ収める', mobile.textLabelsHidden && mobile.railFits && mobile.headerFits, mobile);

await browser.close();
console.log(`\n=== RESULT: ${failures.length ? 'FAIL' : 'PASS'} (${failures.length} failures) ===`);
if (failures.length) process.exitCode = 1;
