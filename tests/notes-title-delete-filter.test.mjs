// 段階3: ノートの名前・削除（ソフトデリート＝ゴミ箱）・名前/中身での絞り込み。
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
  page.on('pageerror', (err) => failures.push({ label: 'pageerror', detail: err.message }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.notes.v1'));
  await page.reload({ waitUntil: 'networkidle' });

  // ノートA: "alpha"、ノートB: "betabeta" という中身の2ノートを作る。
  async function typeLatin(text) {
    await page.click('math-field');
    let guard = 0;
    while (await page.evaluate(() => window.__neoApp.getBaseLayer()) !== 'latin' && guard++ < 3) await page.keyboard.press('Tab');
    for (const ch of text) await page.keyboard.press(`Key${ch.toUpperCase()}`);
    await page.waitForTimeout(650);
  }

  await page.evaluate(() => window.__neoApp.newNote());
  await typeLatin('alpha');
  const noteAId = await page.evaluate(() => window.__neoApp.getNotes().activeId);

  await page.click('#new-note');
  await typeLatin('betabeta');
  const noteBId = await page.evaluate(() => window.__neoApp.getNotes().activeId);
  ok('2件のノートが別IDで保存されている', noteAId && noteBId && noteAId !== noteBId, { noteAId, noteBId });

  await page.click('#notes-toggle');
  await page.waitForTimeout(30);

  console.log('\n== 1. 名前を付ける（未設定は自動プレビューのまま） ==');
  const beforeName = await page.evaluate((id) => document.querySelector(`.note-list-item[data-note-id="${id}"] b`)?.textContent, noteAId);
  ok('名前未設定は中身からの自動プレビュー', beforeName === 'alpha', beforeName);
  await page.click(`.note-list-item[data-note-id="${noteAId}"] button.note-item-action:not(.note-item-action-delete)`);
  await page.fill('.note-item-rename-input', 'テスト用ノート');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(30);
  const afterName = await page.evaluate((id) => window.__neoApp.getNotes().notes.find((n) => n.id === id)?.title, noteAId);
  ok('名前を保存する', afterName === 'テスト用ノート', afterName);
  const shownName = await page.evaluate((id) => document.querySelector(`.note-list-item[data-note-id="${id}"] b`)?.textContent, noteAId);
  ok('一覧の表示も新しい名前になる', shownName === 'テスト用ノート', shownName);

  console.log('\n== 2. 名前・中身での絞り込み ==');
  await page.fill('#notes-search', 'beta');
  await page.waitForTimeout(30);
  let visible = await page.evaluate(() => [...document.querySelectorAll('#notes-list-items .note-list-item')].map((el) => el.dataset.noteId));
  ok('中身(beta)で絞り込むとノートBだけが残る', visible.length === 1 && visible[0] === noteBId, visible);

  await page.fill('#notes-search', 'テスト用');
  await page.waitForTimeout(30);
  visible = await page.evaluate(() => [...document.querySelectorAll('#notes-list-items .note-list-item')].map((el) => el.dataset.noteId));
  ok('名前(テスト用)で絞り込むとノートAだけが残る', visible.length === 1 && visible[0] === noteAId, visible);

  await page.fill('#notes-search', 'まったく一致しない文字列xyz');
  await page.waitForTimeout(30);
  const emptyText = await page.evaluate(() => document.querySelector('#notes-list-items .note-list-empty')?.textContent);
  ok('一致しないときは0件専用の空状態文言を出す', emptyText === '一致するノートがありません', emptyText);

  await page.fill('#notes-search', '');
  await page.waitForTimeout(30);
  visible = await page.evaluate(() => [...document.querySelectorAll('#notes-list-items .note-list-item')].map((el) => el.dataset.noteId));
  ok('絞り込みを消すと両方戻る', visible.length === 2, visible);

  console.log('\n== 3. 削除はソフトデリート（ゴミ箱経由で復元できる） ==');
  await page.click(`.note-list-item[data-note-id="${noteBId}"] button.note-item-action-delete`);
  await page.waitForTimeout(30);
  visible = await page.evaluate(() => [...document.querySelectorAll('#notes-list-items .note-list-item')].map((el) => el.dataset.noteId));
  ok('削除直後は一覧から消える', !visible.includes(noteBId), visible);
  const stillExists = await page.evaluate((id) => {
    const note = window.__neoApp.getNotes().notes.find((n) => n.id === id);
    return note ? { deletedAt: note.deletedAt, rows: note.rows } : null;
  }, noteBId);
  ok('データとしては物理削除されず、deletedAtが立つだけ（誤削除が戻せる）', stillExists && typeof stillExists.deletedAt === 'string' && stillExists.rows.join('').length > 0, stillExists);

  await page.click('#notes-trash-toggle');
  await page.waitForTimeout(30);
  let trashVisible = await page.evaluate(() => [...document.querySelectorAll('#notes-trash-list .note-list-item')].map((el) => el.dataset.noteId));
  ok('ゴミ箱に削除したノートが出る', trashVisible.includes(noteBId), trashVisible);

  await page.click(`.note-list-item-trash[data-note-id="${noteBId}"] button.note-item-action:not(.note-item-action-delete)`);
  await page.waitForTimeout(30);
  const restored = await page.evaluate((id) => window.__neoApp.getNotes().notes.find((n) => n.id === id)?.deletedAt, noteBId);
  ok('「元に戻す」でdeletedAtが外れる', restored === null, restored);
  visible = await page.evaluate(() => [...document.querySelectorAll('#notes-list-items .note-list-item')].map((el) => el.dataset.noteId));
  ok('復元後は通常の一覧に戻る', visible.includes(noteBId), visible);

  console.log('\n== 4. 表示中のノートを削除すると別ノートへ切り替わる ==');
  await page.click(`.note-list-item[data-note-id="${noteAId}"]`);
  await page.waitForTimeout(60);
  const activeBefore = await page.evaluate(() => window.__neoApp.getNotes().activeId);
  ok('ノートAを開いた', activeBefore === noteAId, activeBefore);
  await page.click(`.note-list-item[data-note-id="${noteAId}"] button.note-item-action-delete`);
  await page.waitForTimeout(60);
  const activeAfter = await page.evaluate(() => window.__neoApp.getNotes().activeId);
  ok('表示中ノートを削除すると別の生存ノートへ自動で切り替わる（編集面が削除済みノートを表示し続けない）', activeAfter !== noteAId && activeAfter !== null, activeAfter);

  console.log('\n== 5. ゴミ箱からの完全削除は確認を挟み、実行後は本当に消える ==');
  await page.click('#notes-trash-toggle'); // 開き直す
  await page.waitForTimeout(30);
  await page.click('#notes-trash-toggle');
  await page.waitForTimeout(30);
  let dialogSeen = false;
  page.once('dialog', async (dialog) => { dialogSeen = true; await dialog.accept(); });
  await page.click(`.note-list-item-trash[data-note-id="${noteAId}"] button.note-item-action-delete`);
  await page.waitForTimeout(60);
  ok('完全削除の前に確認ダイアログを挟む', dialogSeen);
  const purged = await page.evaluate((id) => window.__neoApp.getNotes().notes.some((n) => n.id === id), noteAId);
  ok('確認を承認すると本当にstoreから消える', purged === false, purged);

  ok('画面エラーなし', failures.filter((f) => f.label === 'pageerror').length === 0);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
