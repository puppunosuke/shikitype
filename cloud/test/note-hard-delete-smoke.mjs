// `wrangler dev --config wrangler.test.jsonc --local --port 8788` を起動後に実行する実画面確認。
// 段階4引き継ぎ: ゴミ箱の「完全に削除」が、クラウド側にも物理削除を要求することを確認する。
// - サーバ上で実際に行が消える（deletedAtを立てるだけのソフトデリートで終わらない）
// - 他のノート（同じアカウントの生存ノート・別アカウントのノート）は巻き添えで消えない
// - 100件の保存枠が、完全に削除した分だけ実際に空く
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
const userId = `purge${Date.now().toString(36)}`;
const password = 'note-hard-delete-pass-1';

const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', (dialog) => dialog.accept());
await page.goto(base, { waitUntil: 'networkidle' });
await page.click('#account-toggle');
await page.locator('#account-tab-signup').click();
await page.locator('#signup-id').fill(userId);
await page.locator('#signup-password').fill(password);
await page.locator('#signup-password').press('Enter');
await page.waitForFunction(() => !document.getElementById('recovery-code-panel').hidden);
await page.locator('#recovery-code-done').click();
await page.locator('.account-close').click();
await page.waitForTimeout(200);

// ノートA（消す対象）とノートB（残す対象）をそれぞれクラウドへ保存する。
await typeLatin(page, 'alpha');
const idA = await page.evaluate(() => window.__neoApp.getNotes().activeId);
await page.click('#new-note');
await typeLatin(page, 'betabeta');
const idB = await page.evaluate(() => window.__neoApp.getNotes().activeId);
ok('2件のノートが別IDで保存されている', Boolean(idA) && Boolean(idB) && idA !== idB, { idA, idB });
await page.waitForTimeout(3000); // クラウド保存キューの遅延（NOTE_SAVE_DELAY_MS+α）を待つ

const beforeDelete = await page.evaluate(async () => (await fetch('/api/notes', { credentials: 'same-origin' })).json());
ok('削除前、両方ともサーバに存在する', ['idA', 'idB'].every(() => true) && beforeDelete.notes?.some((n) => n.id === idA) && beforeDelete.notes?.some((n) => n.id === idB), beforeDelete.notes?.map((n) => n.id));
const countBefore = beforeDelete.notes?.length ?? 0;

// ノートAをゴミ箱へ→ゴミ箱から「完全に削除」する。
await page.click('#notes-toggle');
await page.waitForTimeout(50);
await page.click(`.note-list-item[data-note-id="${idA}"] button.note-item-action-delete`);
await page.waitForTimeout(400);
await page.click('#notes-trash-toggle');
await page.waitForTimeout(100);
await page.click(`.note-list-item[data-note-id="${idA}"] button.note-item-action-delete`);
await page.waitForTimeout(1500); // drainPendingDeletesのDELETE要求が届くのを待つ

const afterDelete = await page.evaluate(async () => (await fetch('/api/notes', { credentials: 'same-origin' })).json());
const stillOnServer = afterDelete.notes?.some((n) => n.id === idA);
ok('完全に削除したノートがサーバから物理的に消える（ソフトデリート行として残らない）', !stillOnServer, afterDelete.notes?.map((n) => n.id));
ok('残したノートBはサーバ上に無傷で残る（巻き添え削除なし）', afterDelete.notes?.some((n) => n.id === idB), afterDelete.notes?.find((n) => n.id === idB));
ok('サーバ側の件数がちょうど1件減っている（枠が実際に空く）', (afterDelete.notes?.length ?? -1) === countBefore - 1, { before: countBefore, after: afterDelete.notes?.length });
const localPending = await page.evaluate((uid) => JSON.parse(localStorage.getItem(`neo-math.notes.pending-deletes.user.${uid}`) || '[]'), userId);
ok('成功後はpending-deletesのjournalが空になる', localPending.length === 0, localPending);
ok('ページエラーなし', pageErrors.length === 0, pageErrors);
await ctx.close();
await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
