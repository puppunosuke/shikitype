// `wrangler dev --config wrangler.test.jsonc --local --port 8788` を起動後に実行する実画面確認。
import { chromium } from '../../spike/node_modules/playwright/index.mjs';

const base = 'http://127.0.0.1:8788/';
const user = `ui${Date.now().toString(36)}`;
const password = 'local-ui-password-123';
const nextPassword = 'local-ui-password-456';
const themes = ['06', '08', '09', '13', '18'];
let passed = 0;
const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}`, detail); } }
async function closeReturnsToMath(page, label) {
  let focused = false;
  try {
    await page.waitForFunction(() => {
      const mf = document.querySelector('math-field');
      return !!mf && document.activeElement === mf && mf.shadowRoot?.activeElement?.classList.contains('ML__keyboard-sink');
    }, undefined, { timeout: 450 });
    focused = true;
  } catch { /* assertion below */ }
  ok(`${label}: 450ms以内に数式欄へ戻る`, focused);
  if (!focused) return;
  const before = await page.evaluate(() => window.__neoApp.getActiveRow().mf.value);
  await page.keyboard.press('KeyG');
  let typed = false;
  try { await page.waitForFunction((value) => window.__neoApp.getActiveRow().mf.value !== value, before, { timeout: 450 }); typed = true; } catch { /* assertion below */ }
  ok(`${label}: 閉じた直後の実打鍵が式へ入る`, typed);
}

const browser = await chromium.launch({ headless: true });
// フォーカス復帰の実打鍵はノートを編集する。認証・同期の検証とは別の
// ブラウザコンテキストで行い、匿名ノートのimportや保存キューを混ぜない。
const focusContext = await browser.newContext({ viewport: { width: 360, height: 760 } });
const focusPage = await focusContext.newPage();
await focusPage.goto(base, { waitUntil: 'networkidle' });
await focusPage.click('#account-toggle');
await focusPage.keyboard.press('Escape');
await closeReturnsToMath(focusPage, 'Esc');
await focusPage.click('#account-toggle');
await focusPage.locator('.account-close').click();
await closeReturnsToMath(focusPage, '×');
await focusPage.click('#account-toggle');
await focusPage.locator('#account-tab-signup').click();
await focusPage.locator('#signup-id').fill(`focus${Date.now().toString(36)}`);
await focusPage.locator('#signup-password').fill(password);
await focusPage.locator('#signup-password').press('Enter');
await focusPage.waitForFunction(() => !document.getElementById('recovery-code-panel').hidden);
await focusPage.locator('.account-close').click();
await closeReturnsToMath(focusPage, 'アカウント作成後');
await focusPage.click('#account-toggle');
await focusPage.click('#logout-submit');
await closeReturnsToMath(focusPage, 'ログアウト後');
await focusContext.close();

const context = await browser.newContext({ viewport: { width: 360, height: 760 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`${error.message}\n${error.stack || ''}`));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto(base, { waitUntil: 'networkidle' });
await page.click('#account-toggle');
ok('ログイン以外のフォームは最初は非表示', await page.locator('#account-panel-signup').evaluate((el) => el.hidden) && await page.locator('#account-panel-recover').evaluate((el) => el.hidden));
await page.locator('#account-tab-login').press('ArrowRight');
ok('タブの右矢印でアカウント作成へ移る', await page.locator('#account-tab-signup').getAttribute('aria-selected') === 'true');
await page.locator('#account-tab-signup').press('End');
ok('Endで回復タブへ移る', await page.locator('#account-tab-recover').getAttribute('aria-selected') === 'true');
await page.locator('#account-tab-recover').press('Home');
await page.locator('#account-tab-login').press('ArrowRight');
await page.keyboard.press('Enter');
await page.locator('#signup-id').fill(user);
await page.locator('#signup-password').fill(password);
await page.locator('#signup-password').press('Enter');
await page.waitForFunction(() => !document.getElementById('recovery-code-panel').hidden);
const recovery = await page.locator('#recovery-code').textContent();
ok('作成直後に回復コードを一度表示', /^ST-[A-F0-9]{32}$/.test(recovery || ''));
await page.locator('.account-close').click();
await page.waitForFunction(() => !document.getElementById('account-dialog').open);
await page.click('math-field');
// PlaywrightのTabはブラウザのフォーカス移動にも使われるため、ここでは実際の
// 画面キーで入力する。物理キーの層遷移は既存ブラウザ回帰で別途検証する。
await page.click('#key-guide-board .key-cap[data-code="KeyX"]');
await page.waitForFunction(() => window.__neoApp.getNotes().notes.length === 1);
await page.waitForFunction(() => document.getElementById('sync-status').textContent === 'クラウドに保存済み');
const syncedRemote = await page.evaluate(async () => ({ local: window.__neoApp.getNotes(), remote: await (await fetch('/api/notes')).json(), status: document.getElementById('sync-status').textContent }));
ok('入力をクラウドへ保存', syncedRemote.remote.notes.some((note) => note.rows.some((row) => row.includes('geqq'))), syncedRemote);
await page.click('#account-toggle');
await page.click('#logout-submit');
await page.waitForFunction(() => !document.getElementById('account-dialog').open);
await page.click('#account-toggle');
await page.locator('#login-id').fill(user);
await page.locator('#login-password').fill(password);
await page.locator('#login-password').press('Enter');
await page.waitForFunction(() => document.getElementById('account-user-id').textContent === document.getElementById('login-id').value);
ok('ログアウト後の再ログインで同じアカウントへ戻る', true);
await page.locator('.account-close').click();
await page.waitForTimeout(700);
const restoredNotes = await page.evaluate(async () => ({ local: window.__neoApp.getNotes(), remote: await (await fetch('/api/notes')).json() }));
ok('再ログイン後にノートを復元', restoredNotes.local.notes.some((note) => note.rows.some((row) => row.includes('geqq'))), restoredNotes);

// 最初の保存応答を保留し、その間に追加入力しても最終状態だけをACK後に保存できる。
let releaseFirstPut;
const firstPutReleased = new Promise((resolve) => { releaseFirstPut = resolve; });
let firstPutStarted;
const firstPutStartedPromise = new Promise((resolve) => { firstPutStarted = resolve; });
let held = false;
await page.route('**/api/notes/*', async (route) => {
  if (route.request().method() === 'PUT' && !held) {
    held = true;
    firstPutStarted();
    await firstPutReleased;
  }
  await route.continue();
});
await page.click('math-field');
await page.click('#key-guide-board .key-cap[data-code="KeyX"]');
await firstPutStartedPromise;
await page.click('#key-guide-board .key-cap[data-code="KeyG"]');
releaseFirstPut();
await page.waitForFunction(() => document.getElementById('sync-status').textContent === 'クラウドに保存済み');
const delayedSave = await page.evaluate(async () => ({ local: window.__neoApp.getNotes(), remote: await (await fetch('/api/notes')).json() }));
ok('保存応答待ちの追加入力を落とさない', delayedSave.remote.notes.some((note) => note.rows.some((row) => (row.match(/geqq/g) || []).length >= 2 && note.revision >= 2)), JSON.stringify(delayedSave));
await page.unroute('**/api/notes/*');

// Aを端末から切り、Bを作成しても互いのノートを混ぜない。
const other = `ui${(Date.now() + 1).toString(36)}`;
await page.click('#account-toggle');
await page.click('#logout-submit');
await page.click('#account-toggle');
await page.locator('#account-tab-signup').click();
await page.locator('#signup-id').fill(other);
await page.locator('#signup-password').fill(password);
await page.locator('#signup-password').press('Enter');
await page.waitForFunction(() => document.getElementById('account-user-id').textContent.length > 0);
await page.locator('.account-close').click();
const bNotes = await page.evaluate(async () => ({ local: window.__neoApp.getNotes(), remote: await (await fetch('/api/notes')).json() }));
ok('別アカウントにはAのノートを見せない', bNotes.local.notes.length === 0 && bNotes.remote.notes.length === 0, bNotes);
await page.click('#account-toggle');
await page.click('#logout-submit');
await page.click('#account-toggle');
await page.locator('#account-tab-login').click();
await page.locator('#login-id').fill(user);
await page.locator('#login-password').fill(password);
await page.locator('#login-password').press('Enter');
await page.waitForFunction(() => document.getElementById('account-user-id').textContent === document.getElementById('login-id').value);
await page.locator('.account-close').click();
const backToA = await page.evaluate(async () => ({ local: window.__neoApp.getNotes(), remote: await (await fetch('/api/notes')).json() }));
ok('Aへ戻るとAのノートだけを復元', backToA.local.notes.length >= 1 && backToA.remote.notes.length >= 1, backToA);

await page.click('#account-toggle');
await page.click('#logout-submit');
await page.click('#account-toggle');
await page.locator('#account-tab-recover').click();
await page.locator('#recover-id').fill(user);
await page.locator('#recover-code').fill(recovery || '');
await page.locator('#recover-password').fill(nextPassword);
await page.locator('#recover-password').press('Enter');
await page.waitForFunction((oldCode) => {
  const value = document.getElementById('recovery-code').textContent || '';
  return /^ST-[A-F0-9]{32}$/.test(value) && value !== oldCode && document.getElementById('account-message').textContent !== '確認しています…';
}, recovery);
const rotated = await page.locator('#recovery-code').textContent();
ok('回復後に新しい回復コードを表示', !!rotated && rotated !== recovery, { recovery, rotated, message: await page.locator('#account-message').textContent() });
for (const width of [360, 736, 1024]) {
  await page.setViewportSize({ width, height: 760 });
  for (const theme of themes) {
    await page.evaluate((id) => window.__neoApp.applyTheme(id), theme);
    const box = await page.locator('#account-dialog').boundingBox();
    ok(`${width}px/${theme}: ダイアログが画面内`, !!box && box.x >= 0 && box.x + box.width <= width, box);
  }
}
ok('実操作でコンソールエラーなし', errors.length === 0, errors);
await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
process.exit(failures.length ? 1 : 0);
