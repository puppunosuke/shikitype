// 復元済み分数へ新しい括弧を足してから戻る、実ブラウザ操作列の回帰。
//
// 旧版は物理キー直接操作（KeyL=分数構造キー、Tabで層切替、#key-guide-boardの
// key-cap要素クリックで丸括弧を直接挿入）を前提にしていたが、現行では:
// - KeyLのような英字キーはrouteShikitypeImeKey()が無条件で読みbufferへ流すため
//   直接構造化しない（変換方式）。
// - #key-guide一式はbody[data-input-system="conversion"] #key-guide
//   { display: none !important; }（commit cfcd009, 2026-09-01）で恒久非表示。
//   さらに.key-cap要素自体にクリックリスナーが無い（app.js内にkey-cap向けの
//   addEventListenerが存在しない）ため、仮に表示されていてもクリックは何も
//   起こさない＝完全に退役している。
// 検証内容（復元済みの複合スタックへ新しい構造を足しても、Backspace一発で
// 追加分だけが消え、既存の分数と2行目が残る）は変えず、読み+Enter確定の
// 現行経路で再現する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log('  OK  ' + label); }
  else { failures.push({ label, detail }); console.log('  FAIL ' + label + ': ' + JSON.stringify(detail)); }
}
function snapshot(page) {
  return page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    const info = row.mf.getElementInfo(row.mf.position);
    return {
      active: window.__neoApp.rows.indexOf(row), latex: row.mf.value, position: row.mf.position,
      mathLiveDepth: info?.depth, leaf: info?.latex,
      stack: row.stack.map(({ kind, slotIndex, slots, openPos, latexBefore }) => ({ kind, slotIndex, slots, openPos, latexBefore })),
      rows: window.__neoApp.rows.map((entry) => entry.mf.value),
    };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  const warnings = [];
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('[neo-math][stack-mismatch]')) warnings.push(message.text());
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    for (const key of ['neo-math.notes.v1', 'neo-math.input-method.v1', 'neo-math.method-base-layer.v1']) localStorage.removeItem(key);
  });
  await page.reload({ waitUntil: 'networkidle' });

  // 新しいノート → 分数（読み「ふぁくと」＝分数=fractionのエイリアス"fraction"）y → 改行z
  await page.click('#new-note');
  await page.click('#new-note-create');
  await page.click('math-field');
  for (const c of ['KeyF', 'KeyR', 'KeyA', 'KeyC', 'KeyT', 'KeyI', 'KeyO', 'KeyN']) await page.keyboard.press(c);
  await page.keyboard.press('Enter'); // 読み"fraction"確定→空の分数を開く
  await page.keyboard.press('KeyY');
  await page.keyboard.press('Enter'); // yを分子スロットへ確定
  await page.keyboard.press('Enter'); // 分母スロットへ進む
  await page.keyboard.press('Enter'); // 分数を閉じる
  await page.keyboard.press('Enter'); // 新しい行
  await page.keyboard.press('KeyZ');
  await page.keyboard.press('Enter'); // zを確定
  await page.waitForTimeout(520);
  const saved = await page.evaluate(() => window.__neoApp.getNotes());
  ok('分数yと2行目zを自動保存する', saved.notes.length === 1 && saved.notes[0].rows.length === 2 && saved.notes[0].rows[0].includes('dfrac') && saved.notes[0].rows[1].includes('z'), saved);

  // 新規ノート → 履歴先頭から復元
  await page.click('#new-note');
  await page.click('#new-note-create');
  await page.click('#notes-toggle');
  await page.click('.note-list-item:first-child');
  await page.waitForTimeout(60);
  const restored = await snapshot(page);
  ok('履歴から2行ノートを復元する', restored.rows.length === 2 && restored.rows[0].includes('dfrac') && restored.rows[1].includes('z'), restored);

  // 復元した式（分数）へ新しい括弧を追加 → 中に9 → ArrowLeft → Backspace
  for (const c of ['KeyP', 'KeyA', 'KeyR', 'KeyE', 'KeyN']) await page.keyboard.press(c);
  await page.keyboard.press('Enter'); // 読み"paren"確定→丸括弧を開く
  const afterParen = await snapshot(page);
  await page.keyboard.press('Digit9');
  await page.keyboard.press('Enter'); // 9を確定して括弧を閉じる
  const afterArrow = await snapshot(page);
  warnings.length = 0;
  await page.keyboard.press('Backspace');
  const afterBackspace = await snapshot(page);
  ok('新しい括弧と復元分数の混在で1要素だけを戻し、分数と2行目を残す',
    afterArrow.latex.length > afterBackspace.latex.length && afterBackspace.latex.includes('dfrac') && afterBackspace.rows[1].includes('z'),
    { restored, afterParen, afterArrow, afterBackspace });
  ok('混在操作列でstack-mismatch警告を出さない', warnings.length === 0, { warnings, afterParen, afterArrow, afterBackspace });
  ok('混在操作列でconsole errorを出さない', errors.length === 0, errors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
