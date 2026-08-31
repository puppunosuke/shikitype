// 保存済みの分数＋括弧へ戻り、矢印とBackspaceを使っても状態警告を出さない回帰。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log('  OK  ' + label); }
  else { failures.push({ label, detail }); console.log('  FAIL ' + label + ': ' + JSON.stringify(detail)); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  const stackWarnings = [];
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('[neo-math][stack-mismatch]')) stackWarnings.push(message.text());
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.notes.v1'));
  await page.reload({ waitUntil: 'networkidle' });

  // (x)/y を専用キー操作で作る。
  await page.click('math-field');
  await page.keyboard.press('KeyL'); // 分子
  await page.keyboard.press('KeyF'); // 分子内の括弧
  await page.keyboard.press('Tab');
  await page.keyboard.press('KeyX');
  await page.keyboard.press('Enter'); // 括弧を閉じる
  await page.keyboard.press('Enter'); // 分母へ
  await page.keyboard.press('KeyY');
  await page.keyboard.press('Enter'); // 分数を閉じる
  await page.waitForTimeout(520);
  const saved = await page.evaluate(() => window.__neoApp.getNotes().notes[0]);
  ok('分数と括弧を含むノートを保存する', !!saved && saved.rows[0].includes('dfrac') && saved.rows[0].includes('left'), saved);

  stackWarnings.length = 0;
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('math-field');
  await page.keyboard.press('ArrowLeft');
  const afterFirstArrow = await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    return { position: row.mf.position, depth: row.stack.length, info: row.mf.getElementInfo(row.mf.position), latex: row.mf.value };
  });
  const before = await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    return { position: row.mf.position, depth: row.stack.length, info: row.mf.getElementInfo(row.mf.position), latex: row.mf.value };
  });
  await page.keyboard.press('Backspace');
  const after = await page.evaluate(() => ({ latex: window.__neoApp.getActiveRow().mf.value, depth: window.__neoApp.getActiveRow().stack.length }));
  ok('復元後の矢印＋Backspaceは式全体を消さず分母の1要素だけを削除する', before.latex.length > after.latex.length && after.latex.includes('dfrac') && after.latex.includes('left'), { afterFirstArrow, before, after });
  ok('復元後の矢印＋Backspaceでstack-mismatch警告を出さない', stackWarnings.length === 0, stackWarnings);
  ok('復元後の矢印＋Backspaceでconsole errorを出さない', errors.length === 0, errors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
