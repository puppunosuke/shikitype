// 段階2からの申し送り修正の回帰確認。
// 新規ノート作成直後にキャンバスへ切り替えて編集を重ね、Ctrl+Zを切替前まで
// 戻し切っても、表示モード(layoutMode)は現在見ているものを保ち続けること。
// カメラのpan/zoomと同じく「表示モードの切替は編集ではない」ため、取り消しの
// 対象に含めない、という段階3の設計方針そのものを実DOMで確認する。
//
// 旧実装は「'latin'基底層へTabで切り替え、物理キーを直接そのまま挿入する」
// 前提だったが、現行のCONVERSION_LAYERSは['symbol', 'greek']だけで'latin'は
// もう存在しない（activeInputLayer()はinputSystem==='conversion'では
// temporaryLayer ?? baseLayerを返すが、cycleBaseLayer/nextConversionLayerが
// symbol/greekしか回さないため、Tabをいくら押してもlatinへは到達しない）。
// 単独の英字は変換辞書に候補が無ければEnter確定時にそのまま1文字として
// 挿入される（実測: KeyA→Enterで"a"）ので、この経路で同じ検証内容
// （行モード編集→キャンバス編集→Ctrl+Zで段階的に戻る）を再現する。
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  // 単独の英字は変換辞書に候補が無ければEnter確定時にそのまま1文字挿入される
  // （現行の変換方式。旧'latin'直接入力層はもう存在しない）。
  async function typeLetterConfirmed(code) {
    await pressCode(code);
    await pressCode('Enter');
  }
  async function value(index) { return page.evaluate((i) => window.__neoApp.rows[i]?.mf.value, index); }
  async function layoutMode() { return page.evaluate(() => window.__neoApp.getLayoutMode()); }

  console.log('\n== 新規ノート→行モードで入力→キャンバスへ切替→編集→Ctrl+Zを戻し切る ==');
  await page.evaluate(() => window.__neoApp.newNote());
  ok('新規ノートは行モードで始まる', await layoutMode() === 'rows', await layoutMode());
  await page.click('math-field');
  await typeLetterConfirmed('KeyA'); // 行モードでの最初の編集
  await page.waitForTimeout(650); // 取り消し単位として確定させる

  await page.click('#sidebar-toggle');
  await page.click('.layout-mode-choice[data-layout-mode="canvas"]');
  await page.click('#sidebar-close');
  ok('キャンバスへ切り替わった', await layoutMode() === 'canvas', await layoutMode());

  await page.click('math-field');
  await typeLetterConfirmed('KeyB'); // キャンバスへ切り替えた後の編集
  await page.waitForTimeout(650);
  ok('キャンバスでの編集後の内容(ab)', await value(0) === 'ab', await value(0));

  // 切替前まで戻し切る（＝キャンバスでの編集を全部取り消す）。
  await undo();
  ok('1回目のCtrl+Zでキャンバス編集(b)を取り消し、内容はaに戻る', await value(0) === 'a', await value(0));
  ok('取り消し後もキャンバス表示のまま（表示モードは編集ではなく取り消し対象外）', await layoutMode() === 'canvas', await layoutMode());

  // さらに戻して行モードでの入力(a)も取り消す。表示モードは依然としてcanvasのまま。
  await undo();
  ok('2回目のCtrl+Zで行モードでの入力(a)も取り消し、内容は空になる', await value(0) === '', await value(0));
  ok('切替前のスナップショットまで戻ってもlayoutModeはcanvasのまま（段階2の申し送りバグの修正）', await layoutMode() === 'canvas', await layoutMode());
  ok('#editor-sheetの見た目もcanvas-modeのまま', await page.locator('#editor-sheet').evaluate((el) => el.classList.contains('canvas-mode')));

  ok('JSエラーなし', errors.length === 0, errors);
  await browser.close();
}

main().then(() => {
  console.log(`\n${passed}件 OK / ${failures.length}件 FAIL`);
  if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }
}).catch((err) => { console.error(err); process.exit(1); });
