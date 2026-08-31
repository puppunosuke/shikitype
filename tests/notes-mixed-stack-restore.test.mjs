// 復元済み分数へ新しい括弧を足してから戻る、実ブラウザ操作列の回帰。
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

  // 新しいノート → 分数y → 改行z
  await page.click('#new-note');
  await page.click('#new-note-create');
  await page.click('math-field');
  await page.keyboard.press('KeyL');
  await page.keyboard.press('Tab');
  await page.keyboard.press('KeyY');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyZ');
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

  // 復元した式へ括弧を追加 → ArrowLeft → Backspace
  await page.evaluate(() => {
    window.__neoApp.handleVirtualSpecial('Tab');
    window.__neoApp.handleVirtualSpecial('Tab');
  });
  await page.click('#key-guide-board .key-cap[data-code="KeyF"]');
  const afterParen = await snapshot(page);
  await page.keyboard.press('ArrowLeft');
  const afterArrow = await snapshot(page);
  warnings.length = 0;
  await page.keyboard.press('Backspace');
  const afterBackspace = await snapshot(page);
  ok('新しい括弧と復元分数の混在で1要素だけを戻し、分数と2行目を残す', afterParen.latex.length > afterBackspace.latex.length && afterBackspace.latex.includes('dfrac') && afterBackspace.rows[1].includes('z'), { restored, afterParen, afterArrow, afterBackspace });
  ok('混在操作列でstack-mismatch警告を出さない', warnings.length === 0, { warnings, afterParen, afterArrow, afterBackspace });
  ok('混在操作列でconsole errorを出さない', errors.length === 0, errors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
