// ノートの自動保存・切替・再読込と、復元後の構造編集を確認する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log('  OK  ' + label); }
  else { failures.push({ label, detail }); console.log('  FAIL ' + label + ': ' + JSON.stringify(detail)); }
}
const value = (page, n = 0) => page.evaluate((index) => window.__neoApp.rows[index]?.mf.value, n);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  page.on('pageerror', (err) => failures.push({ label: 'pageerror', detail: err.message }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.notes.v1'));
  await page.reload({ waitUntil: 'networkidle' });

  await page.click('math-field');
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyX');
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyY');
  await page.waitForTimeout(520);
  const first = await page.evaluate(() => ({ notes: window.__neoApp.getNotes(), rows: window.__neoApp.rows.map((row) => row.mf.value) }));
  ok('複数行の数式を版付き形式で自動保存する', first.notes.version === 1 && first.notes.notes.length === 1 && first.rows.length === 2 && first.notes.notes[0].rows.length === 2, first);

  await page.click('#new-note');
  await page.click('#new-note-create');
  const blank = await page.evaluate(() => ({ rows: window.__neoApp.rows.length, notes: window.__neoApp.getNotes().notes.length, stat: document.getElementById('stat-keystrokes').textContent, active: window.__neoApp.getNotes().activeId }));
  ok('新しいノートは白紙を保存せず統計をリセットする', blank.rows === 1 && blank.notes === 1 && blank.stat === '0' && blank.active === null, blank);
  await page.keyboard.press('KeyA');
  await page.waitForTimeout(520);
  await page.click('#notes-toggle');
  const list = await page.evaluate(() => ({ expanded: document.getElementById('notes-toggle').getAttribute('aria-expanded'), items: [...document.querySelectorAll('.note-list-item')].map((el) => el.dataset.noteId), notes: window.__neoApp.getNotes().notes }));
  ok('過去のノートはアコーディオンで更新順に展開する', list.expanded === 'true' && list.items.length === 2 && list.items[0] === list.notes.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id, list);

  const olderId = first.notes.notes[0].id;
  await page.click(`.note-list-item[data-note-id="${olderId}"]`);
  await page.waitForTimeout(80);
  const restored = await page.evaluate(() => ({ rows: window.__neoApp.rows.map((row) => row.mf.value), active: window.__neoApp.getNotes().activeId }));
  ok('選択したノートの全行を復元する', restored.active === olderId && restored.rows.length === 2 && restored.rows[0].includes('\\left') && restored.rows[1].includes('lim'), restored);

  await page.reload({ waitUntil: 'networkidle' });
  const reloaded = await page.evaluate(() => ({ rows: window.__neoApp.rows.map((row) => row.mf.value), active: window.__neoApp.getNotes().activeId }));
  ok('再読込後も選択中ノートを復元する', reloaded.active === olderId && reloaded.rows.length === 2 && reloaded.rows[0].includes('\\left'), reloaded);

  await page.click('math-field');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  const edited = await value(page);
  ok('復元した括弧をBackspaceしても行全体を失わない', typeof edited === 'string' && edited.length > 0, edited);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
