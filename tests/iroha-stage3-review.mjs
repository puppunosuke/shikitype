// 彩葉レビュー用の探索スクリプト。段階3(ノート名/削除/絞り込み/LaTeX書き出し)の
// UI/UX観点を実測する。既存テストと違い合否判定ではなく、座標・可視性・階層を集める。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';

async function withPage(viewport, fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.notes.v1'));
  await page.reload({ waitUntil: 'networkidle' });
  await fn(page);
  if (errors.length) console.log('  PAGE ERRORS:', errors);
  await browser.close();
}

async function typeLatin(page, text) {
  await page.click('math-field');
  let guard = 0;
  while (await page.evaluate(() => window.__neoApp.getBaseLayer()) !== 'latin' && guard++ < 3) await page.keyboard.press('Tab');
  for (const ch of text) await page.keyboard.press(`Key${ch.toUpperCase()}`);
  await page.waitForTimeout(120);
}

console.log('=== 1. 15件のノートで一覧・絞り込み・並び順を確認 ===');
await withPage({ width: 1280, height: 900 }, async (page) => {
  const letters = 'abcdefghijklmno'.split('');
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => window.__neoApp.newNote());
    await typeLatin(page, `note${letters[i]}`);
    await page.waitForTimeout(650); // debounce保存を確実に踏む
  }
  // 名前を1件だけ付ける
  await page.click('#notes-toggle');
  await page.waitForTimeout(150);
  const items = await page.$$('.note-list-item');
  console.log('  一覧アイテム数(15件作成後):', items.length);
  // ソフトデリートを3件行う
  for (let i = 0; i < 3; i++) {
    const delBtn = await page.$('.note-item-action-delete');
    if (delBtn) await delBtn.click();
    await page.waitForTimeout(80);
  }
  const afterDelete = await page.$$('.note-list-item');
  console.log('  3件削除後の一覧アイテム数:', afterDelete.length, '(期待値: 12)');
  // ゴミ箱の可視性: トグル文言、位置
  const trashToggle = await page.$('#notes-trash-toggle');
  const trashText = await trashToggle.textContent();
  console.log('  ゴミ箱トグル文言:', trashText);
  const trashBox = await trashToggle.boundingBox();
  const listBox = await page.$('#notes-list').then((el) => el.boundingBox());
  console.log('  notes-list bbox:', listBox, ' / trash-toggle bbox:', trashBox);
  // スクロールしないと見えないか(一覧が長い状態でゴミ箱ボタンの位置)
  const listScrollHeight = await page.$eval('#notes-list', (el) => el.scrollHeight);
  const listClientHeight = await page.$eval('#notes-list', (el) => el.clientHeight);
  console.log('  notes-list scrollHeight/clientHeight:', listScrollHeight, listClientHeight, '(scroll要否:', listScrollHeight > listClientHeight, ')');
  // 絞り込み
  await page.fill('#notes-search', 'notea');
  await page.waitForTimeout(80);
  const filtered = await page.$$('.note-list-item');
  console.log('  "notea"で絞り込み後の件数:', filtered.length, '(1件を期待)');
  await page.fill('#notes-search', '');
  await page.waitForTimeout(80);
  // 並び順: 新しいものが上か
  const order = await page.$$eval('.note-list-item b', (els) => els.map((e) => e.textContent));
  console.log('  一覧の並び順(先頭5件):', order.slice(0, 5));
});

console.log('\n=== 2. 名前ボタン・TeXボタンの密度(行内で何個並ぶか) ===');
await withPage({ width: 1280, height: 900 }, async (page) => {
  await page.evaluate(() => window.__neoApp.newNote());
  await typeLatin(page, 'notea');
  await page.waitForTimeout(650);
  await page.click('#notes-toggle');
  await page.waitForTimeout(150);
  const actionCount = await page.$$eval('.note-item-action', (els) => els.length);
  console.log('  1アイテムあたりの低頻度操作ボタン数:', actionCount, '(名前+削除=2を期待)');
  const rowTexVisible = await page.$eval('.row-copy-latex', (el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
  console.log('  行モードでTeXボタンが常時表示か:', rowTexVisible);
  await page.screenshot({ path: 'tests/out-iroha-density-row.png' });
});

console.log('\n=== 3. TeXボタンと数式の重なり(横幅いっぱい・上付きが右端にくるケース) ===');
await withPage({ width: 1280, height: 900 }, async (page) => {
  await page.evaluate(() => window.__neoApp.newNote());
  await page.click('math-field');
  await page.evaluate(() => {
    const mf = document.querySelector('math-field');
    mf.value = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa^{2}';
  });
  await page.waitForTimeout(200);
  const rowBox = await page.$('.row').then((el) => el.boundingBox());
  const texBox = await page.$('.row-copy-latex').then((el) => el.boundingBox());
  const mfBox = await page.$('math-field').then((el) => el.boundingBox());
  console.log('  row bbox:', rowBox);
  console.log('  math-field bbox:', mfBox);
  console.log('  TeX button bbox:', texBox);
  await page.screenshot({ path: 'tests/out-iroha-tex-overlap-wide.png' });
});

console.log('\n=== 4. canvasモードでのTeX/削除ボタン位置関係 ===');
await withPage({ width: 1280, height: 900 }, async (page) => {
  await page.evaluate(() => window.__neoApp.newNote());
  await typeLatin(page, 'ab');
  await page.click('#sidebar-toggle'); await page.click('.layout-mode-choice[data-layout-mode="canvas"]'); await page.click('#sidebar-close');
  await page.waitForTimeout(200);
  const del = await page.$('.row-delete').then((el) => el.boundingBox());
  const tex = await page.$('.row-copy-latex').then((el) => el.boundingBox());
  console.log('  canvas削除ボタン bbox:', del);
  console.log('  canvas TeXボタン bbox:', tex);
  const overlap = !(del.x + del.width < tex.x || tex.x + tex.width < del.x || del.y + del.height < tex.y || tex.y + tex.height < del.y);
  console.log('  重なりあり?:', overlap);
  await page.screenshot({ path: 'tests/out-iroha-canvas-buttons.png' });
});

console.log('\n=== 5. 書き出しメニューの重なり(1280px/360px、スクロール位置違い) ===');
for (const width of [1280, 360]) {
  await withPage({ width, height: 900 }, async (page) => {
    await page.evaluate(() => window.__neoApp.newNote());
    await page.click('#export-note-toggle');
    await page.waitForTimeout(150);
    const toggleBox = await page.$('#export-note-toggle').then((el) => el.boundingBox());
    const menuBox = await page.$('#export-note-menu').then((el) => el.boundingBox());
    const firstBtn = await page.$('#export-note-latex-copy').then((el) => el.boundingBox());
    console.log(`  [${width}px] toggle bbox:`, toggleBox);
    console.log(`  [${width}px] menu bbox:`, menuBox);
    const overlapsToggle = !(menuBox.x + menuBox.width < toggleBox.x || toggleBox.x + toggleBox.width < menuBox.x || menuBox.y + menuBox.height < toggleBox.y || toggleBox.y + toggleBox.height < menuBox.y);
    console.log(`  [${width}px] メニューがトグルボタン自身と重なるか:`, overlapsToggle);
    // 実クリックでコピーできるかも確認(奪われていないか)
    const clicked = await page.evaluate(() => {
      const btn = document.getElementById('export-note-latex-copy');
      const rect = btn.getBoundingClientRect();
      const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return el === btn || btn.contains(el);
    });
    console.log(`  [${width}px] コピー ボタンの中心座標が実際にそのボタンで受け取れるか:`, clicked);
    await page.screenshot({ path: `tests/out-iroha-export-menu-${width}.png` });
  });
}

console.log('\n=== 6. スクロールしたキャンバスでのexportメニュー(パン後) ===');
await withPage({ width: 1280, height: 900 }, async (page) => {
  await page.evaluate(() => window.__neoApp.newNote());
  await typeLatin(page, 'ab');
  await page.click('#sidebar-toggle'); await page.click('.layout-mode-choice[data-layout-mode="canvas"]'); await page.click('#sidebar-close');
  await page.waitForTimeout(150);
  // canvasをパンする
  const viewport = await page.$('#canvas-viewport');
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 300, box.y + box.height / 2 - 200, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  await page.click('#export-note-toggle');
  await page.waitForTimeout(150);
  const toggleBox = await page.$('#export-note-toggle').then((el) => el.boundingBox());
  const menuBox = await page.$('#export-note-menu').then((el) => el.boundingBox());
  const overlapsToggle = !(menuBox.x + menuBox.width < toggleBox.x || toggleBox.x + toggleBox.width < menuBox.x || menuBox.y + menuBox.height < toggleBox.y || toggleBox.y + toggleBox.height < menuBox.y);
  console.log('  パン後もメニューがトグルと重ならないか(重ならない=false希望):', overlapsToggle);
});

console.log('\n=== 7. 5テーマでの視認性(TeXボタン・ゴミ箱・検索欄) ===');
for (const theme of ['06', '08', '09', '13', '18']) {
  await withPage({ width: 1280, height: 900 }, async (page) => {
    await page.evaluate((t) => { document.body.dataset.theme = t; }, theme);
    await page.evaluate(() => window.__neoApp.newNote());
    await typeLatin(page, 'a');
    await page.click('#notes-toggle');
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/out-iroha-theme-${theme}.png` });
  });
}

console.log('\n=== 8. 360px幅でのノート一覧・書き出し ===');
await withPage({ width: 360, height: 740 }, async (page) => {
  const letters = 'abcd'.split('');
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__neoApp.newNote());
    await typeLatin(page, `n${letters[i]}`);
    await page.waitForTimeout(650);
  }
  await page.click('#notes-toggle');
  await page.waitForTimeout(150);
  const listBox = await page.$('#notes-list').then((el) => el.boundingBox());
  console.log('  360px notes-list bbox:', listBox, 'viewport幅=360');
  await page.screenshot({ path: 'tests/out-iroha-360-notes.png' });
});

console.log('\n完了');
