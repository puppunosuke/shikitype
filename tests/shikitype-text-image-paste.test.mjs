import { chromium } from '../spike/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const failures = []; let passed = 0;
function ok(label, value, detail = value) { if (value) { passed += 1; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); } }

await page.goto(process.env.NEO_BASE ?? 'http://localhost:8893/app.html', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

console.log('\n== SHIKITYPE専用UIと文章 ==');
const ui = await page.evaluate(() => ({
  system: window.__neoApp.getInputSystem(),
  guide: getComputedStyle(document.getElementById('key-guide')).display,
  textKey: !document.getElementById('text-entry-key').hidden,
  inputNav: Boolean(document.querySelector('.settings-nav-item[data-settings-category="input"]')),
  keysNav: Boolean(document.querySelector('.settings-nav-item[data-settings-category="keys"]')),
}));
ok('SHIKITYPE変換だけを使いキーガイド・入力方式・キー割当を出さない', ui.system === 'conversion' && ui.guide === 'none' && ui.textKey && !ui.inputNav && !ui.keysNav, ui);

await page.click('#text-entry-key'); await page.waitForTimeout(40);
const textOpened = await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); return row.nativeTextOpen && row.mf.mode === 'text'; });
ok('文キーは標準文章入力を開く', textOpened, textOpened);
await page.keyboard.insertText('標準 IME text'); await page.keyboard.press('Enter');
ok('文の内容を保持してEnterで閉じる', (await page.evaluate(() => window.__neoApp.getActiveRow().mf.value)).includes('標準 IME text'));
await page.click('#text-entry-key'); await page.evaluate(() => navigator.clipboard.writeText(' 貼り付け文章')); await page.keyboard.press('Control+KeyV'); await page.keyboard.press('Enter');
ok('文の中だけCtrl+Vを標準テキスト貼り付けへ渡す', (await page.evaluate(() => window.__neoApp.getActiveRow().mf.value)).includes('貼り付け文章'));

console.log('\n== キャンバス画像貼り付け ==');
await page.evaluate(() => window.__neoApp.setLayoutMode('canvas'));
const dispatched = await page.evaluate(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 30;
  const context = canvas.getContext('2d'); context.fillStyle = '#2563eb'; context.fillRect(0, 0, 40, 30);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'paste.png', { type: 'image/png' }));
  return document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
});
await page.waitForTimeout(350);
const imageState = await page.evaluate(() => ({ images: window.__neoApp.getCanvasImages(), dom: document.querySelectorAll('.canvas-image-block').length }));
ok('画像貼り付けをブラウザ既定へ流さずキャンバスブロックにする', dispatched === false && imageState.images.length === 1 && imageState.dom === 1, imageState);
await page.evaluate(() => window.__neoApp.saveNote());
const saved = await page.evaluate(() => window.__neoApp.getNotes().notes.find((note) => note.id === window.__neoApp.getNotes().activeId));
ok('貼り付け画像をノートのlayoutへ保存する', saved?.layout?.images?.length === 1 && saved.layout.images[0].src.startsWith('data:image/'), saved?.layout);

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
