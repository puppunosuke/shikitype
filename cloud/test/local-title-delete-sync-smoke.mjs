// `wrangler dev --config wrangler.test.jsonc --local --port 8788` を起動後に実行する実画面確認。
// 段階4: ノートの名前・ソフトデリート（削除）がクラウド同期に乗ることを、
// 実際のHTTP経由・別ブラウザコンテキスト（別端末を模す）で確認する。
// 拓男の明示承認が無い限り、この検証はローカルのwrangler devだけで行い、本番へは出さない。
import { chromium } from '../../spike/node_modules/playwright/index.mjs';
const base = 'http://127.0.0.1:8788/app.html';
let passed = 0; const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}:`, JSON.stringify(detail)); } }

async function typeLatin(page, text) {
  await page.click('math-field');
  let guard = 0;
  while (await page.evaluate(() => window.__neoApp.getBaseLayer()) !== 'latin' && guard++ < 3) await page.keyboard.press('Tab');
  for (const ch of text) await page.keyboard.press(`Key${ch.toUpperCase()}`);
  await page.waitForTimeout(650);
}

const browser = await chromium.launch({ headless: true });
const userId = `sync${Date.now().toString(36)}`;
const password = 'title-delete-sync-pass-1';

// デバイスA: サインアップ→式を書く→名前を付ける→削除する
const ctxA = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const pageA = await ctxA.newPage();
const errorsA = [];
pageA.on('pageerror', (e) => errorsA.push(e.message));
await pageA.goto(base, { waitUntil: 'networkidle' });
await pageA.click('#account-toggle');
await pageA.locator('#account-tab-signup').click();
await pageA.locator('#signup-id').fill(userId);
await pageA.locator('#signup-password').fill(password);
await pageA.locator('#signup-password').press('Enter');
await pageA.waitForFunction(() => !document.getElementById('recovery-code-panel').hidden);
await pageA.locator('#recovery-code-done').click();
await pageA.locator('.account-close').click();
await pageA.waitForTimeout(200);

await typeLatin(pageA, 'sekibun');
const noteId = await pageA.evaluate(() => window.__neoApp.getNotes().activeId);
ok('ノートが保存されている', Boolean(noteId), noteId);

await pageA.click('#notes-toggle');
await pageA.waitForTimeout(50);
await pageA.click(`.note-list-item[data-note-id="${noteId}"] button.note-item-action:not(.note-item-action-delete)`);
await pageA.fill('.note-item-rename-input', '積分のメモ');
await pageA.keyboard.press('Enter');
await pageA.waitForTimeout(3000); // クラウド保存キューの遅延（NOTE_SAVE_DELAY_MS+α）を待つ

const remoteAfterRename = await pageA.evaluate(async () => (await fetch('/api/notes', { credentials: 'same-origin' })).json());
const namedNote = remoteAfterRename.notes?.find((n) => n.id === noteId);
ok('名前変更がクラウドへ届く', namedNote?.title === '積分のメモ', namedNote);

await pageA.click(`.note-list-item[data-note-id="${noteId}"] button.note-item-action-delete`);
await pageA.waitForTimeout(3000);
const remoteAfterDelete = await pageA.evaluate(async () => (await fetch('/api/notes', { credentials: 'same-origin' })).json());
const deletedNote = remoteAfterDelete.notes?.find((n) => n.id === noteId);
ok('削除（ソフトデリート）がクラウドへ届く', Boolean(deletedNote?.deletedAt), deletedNote);
ok('デバイスAにページエラーなし', errorsA.length === 0, errorsA);
await ctxA.close();

// デバイスB: 別コンテキストから同じアカウントへログインし、名前つき・削除済みのまま見える
const ctxB = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const pageB = await ctxB.newPage();
const errorsB = [];
pageB.on('pageerror', (e) => errorsB.push(e.message));
await pageB.goto(base, { waitUntil: 'networkidle' });
await pageB.click('#account-toggle');
await pageB.locator('#login-id').fill(userId);
await pageB.locator('#login-password').fill(password);
await pageB.locator('#login-password').press('Enter');
await pageB.waitForTimeout(1500);
await pageB.locator('.account-close').click();
await pageB.waitForTimeout(300);
await pageB.click('#notes-toggle');
await pageB.click('#notes-trash-toggle');
await pageB.waitForTimeout(200);
const trashText = await pageB.evaluate(() => document.getElementById('notes-trash-list')?.textContent || '');
ok('別端末でも名前つきのままゴミ箱に見える（欠陥修正の核心）', trashText.includes('積分のメモ'), trashText);
const activeListText = await pageB.evaluate(() => document.getElementById('notes-list-items')?.textContent || '');
ok('削除済みノートは別端末の一覧側には出ない', !activeListText.includes('積分のメモ'), activeListText);
ok('デバイスBにページエラーなし', errorsB.length === 0, errorsB);
await ctxB.close();

await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
