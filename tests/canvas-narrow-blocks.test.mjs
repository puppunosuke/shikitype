import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
const themes = ['06', '08', '09', '13', '18'];
const widths = [1024, 736, 360];
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

const browser = await chromium.launch({ headless: true });
for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: 760 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  for (const theme of themes) {
    await page.evaluate((themeId) => {
      window.__neoApp.applyTheme(themeId, false);
      window.__neoApp.newNote();
      window.__neoApp.setLayoutMode('canvas');
    }, theme);
    await page.waitForTimeout(40);
    const geometry = await page.evaluate(() => {
      const viewport = document.getElementById('canvas-viewport').getBoundingClientRect();
      const row = window.__neoApp.getActiveRow();
      const block = row.wrap.getBoundingClientRect();
      const remove = row.wrap.querySelector('.row-delete').getBoundingClientRect();
      return {
        viewport: { left: viewport.left, right: viewport.right, top: viewport.top, bottom: viewport.bottom },
        block: { left: block.left, right: block.right, top: block.top, bottom: block.bottom },
        remove: { left: remove.left, right: remove.right, top: remove.top, bottom: remove.bottom, width: remove.width, height: remove.height },
        camera: window.__neoApp.getCanvasCamera(),
        world: window.__neoApp.getCanvasBlocks()[0],
      };
    });
    const within = geometry.block.left >= geometry.viewport.left - 1 && geometry.block.right <= geometry.viewport.right + 1
      && geometry.remove.left >= geometry.viewport.left - 1 && geometry.remove.right <= geometry.viewport.right + 1
      && geometry.remove.top >= geometry.viewport.top - 1 && geometry.remove.bottom <= geometry.viewport.bottom + 1;
    ok(`${theme}/${width}px: 初期canvas blockと×がviewport内`, within && geometry.remove.width >= 44 && geometry.remove.height >= 44, geometry);

    // 端を押しても、クリック座標をできるだけ保ちながら新規block全体だけを画面内に止める。
    // 最後はtouchとして送って、mouseと同じ座標補正経路を通す。
    const createdAtEdges = await page.evaluate(() => {
      const viewport = document.getElementById('canvas-viewport');
      const rect = viewport.getBoundingClientRect();
      const points = [
        [4, 4], [rect.width - 4, 4], [4, rect.height - 4], [rect.width - 4, rect.height - 4],
      ];
      for (const [x, y] of points) {
        viewport.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 200 + x + y, pointerType: 'mouse', button: 0, clientX: rect.left + x, clientY: rect.top + y, bubbles: true, cancelable: true }));
        viewport.dispatchEvent(new PointerEvent('pointerup', { pointerId: 200 + x + y, pointerType: 'mouse', button: 0, clientX: rect.left + x, clientY: rect.top + y, bubbles: true, cancelable: true }));
      }
      const touchX = rect.width - 4; const touchY = rect.height / 2;
      viewport.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 299, pointerType: 'touch', clientX: rect.left + touchX, clientY: rect.top + touchY, bubbles: true, cancelable: true }));
      viewport.dispatchEvent(new PointerEvent('pointerup', { pointerId: 299, pointerType: 'touch', clientX: rect.left + touchX, clientY: rect.top + touchY, bubbles: true, cancelable: true }));
      return [...window.__neoApp.rows].slice(-5).map((row) => {
        const block = row.wrap.getBoundingClientRect();
        const remove = row.wrap.querySelector('.row-delete').getBoundingClientRect();
        return { block: { left: block.left, right: block.right, top: block.top, bottom: block.bottom }, remove: { left: remove.left, right: remove.right, top: remove.top, bottom: remove.bottom, width: remove.width, height: remove.height } };
      });
    });
    const createdWithin = createdAtEdges.every(({ block, remove }) => block.left >= geometry.viewport.left - 1 && block.right <= geometry.viewport.right + 1
      && block.top >= geometry.viewport.top - 1 && block.bottom <= geometry.viewport.bottom + 1
      && remove.left >= geometry.viewport.left - 1 && remove.right <= geometry.viewport.right + 1
      && remove.top >= geometry.viewport.top - 1 && remove.bottom <= geometry.viewport.bottom + 1
      && remove.width >= 44 && remove.height >= 44);
    ok(`${theme}/${width}px: 端のclick/tapで作るblockも×を含めviewport内`, createdWithin, createdAtEdges);
    for (let index = 0; index < 5; index++) await page.locator('.row-delete').last().click();

    const saved = await page.evaluate(() => {
      const row = window.__neoApp.getActiveRow();
      row.mf.value = 'x'; row.mf.position = row.mf.lastOffset;
      window.__neoApp.saveNote();
      return { camera: window.__neoApp.getCanvasCamera(), blocks: window.__neoApp.getCanvasBlocks() };
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__neoApp.getLayoutMode() === 'canvas' && window.__neoApp.getCanvasBlocks().some((block) => block.latex === 'x'));
    const restored = await page.evaluate(() => ({ camera: window.__neoApp.getCanvasCamera(), blocks: window.__neoApp.getCanvasBlocks() }));
    ok(`${theme}/${width}px: 狭幅補正はcameraと保存座標を変えない`, JSON.stringify(restored.camera) === JSON.stringify(saved.camera) && JSON.stringify(restored.blocks) === JSON.stringify(saved.blocks), { saved, restored });

    await page.locator('.row-delete').click();
    await page.waitForTimeout(20);
    const deleted = await page.evaluate(() => ({ rows: window.__neoApp.rows.length, mode: window.__neoApp.getLayoutMode() }));
    ok(`${theme}/${width}px: viewport内の×でblockを削除できる`, deleted.rows === 0 && deleted.mode === 'canvas', deleted);
  }
  ok(`${width}px: 画面エラーなし`, errors.length === 0, errors);
  await context.close();
}
await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
