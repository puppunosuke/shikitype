import { chromium } from '../../spike/node_modules/playwright/index.mjs';

const base = 'http://127.0.0.1:8788/';
const password = 'local-lossless-password-123';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}`, detail); } }
function note(id, rows) { return { id, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', unitId: 's3-sekibun', rows, revision: 0 }; }
async function pageWithAnonymous(context, notes) {
  const page = await context.newPage();
  await page.addInitScript(({ store }) => localStorage.setItem('neo-math.notes.v1', JSON.stringify(store)), { store: { version: 1, activeId: notes[0]?.id || null, notes } });
  await page.goto(base, { waitUntil: 'networkidle' });
  return page;
}
async function signup(page, id) {
  await page.click('#account-toggle');
  await page.click('#account-tab-signup');
  await page.locator('#signup-id').fill(id);
  await page.locator('#signup-password').fill(password);
  await page.locator('#signup-password').press('Enter');
  await page.waitForFunction(() => document.getElementById('account-user-id').textContent.length > 0);
}
async function login(page, id) {
  await page.click('#account-toggle');
  await page.click('#account-tab-login');
  await page.locator('#login-id').fill(id);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-password').press('Enter');
  await page.waitForFunction(() => document.getElementById('account-user-id').textContent.length > 0);
}
async function logout(page) {
  if (!await page.locator('#account-dialog').evaluate((dialog) => dialog.open)) await page.click('#account-toggle');
  await page.click('#logout-submit');
  await page.waitForFunction(() => document.getElementById('account-user-id').textContent === '');
}

const browser = await chromium.launch({ headless: true });
const bigContext = await browser.newContext({ viewport: { width: 1024, height: 760 } });
const largeRows = Array.from({ length: 31 }, () => 'x'.repeat(3600));
const largeNotes = [note(`note-${crypto.randomUUID()}`, largeRows), note(`note-${crypto.randomUUID()}`, largeRows.map((row) => `y${row.slice(1)}`))];
const largePage = await pageWithAnonymous(bigContext, largeNotes);
let importCalls = 0;
await largePage.route('**/api/notes/import', async (route) => {
  importCalls += 1;
  if (importCalls === 2) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_failure' }) });
  else await route.continue();
});
const largeUser = `large${Date.now().toString(36)}`;
await signup(largePage, largeUser);
const afterFailure = await largePage.evaluate(async () => ({ local: window.__neoApp.getNotes(), remote: await (await fetch('/api/notes')).json(), status: document.getElementById('sync-status').textContent }));
ok('110KB級2件を制限内chunkへ分割する', importCalls === 2, importCalls);
ok('途中chunk失敗でもローカル2件を保持する', largeNotes.every((note) => afterFailure.local.notes.some((local) => local.id === note.id)) && afterFailure.remote.notes.length === 1, { local: afterFailure.local.notes.map((note) => note.id), remote: afterFailure.remote.notes.length, status: afterFailure.status });
await largePage.unroute('**/api/notes/import');
await logout(largePage);
await login(largePage, largeUser);
const afterRetry = await largePage.evaluate(async () => ({ local: window.__neoApp.getNotes(), remote: await (await fetch('/api/notes')).json() }));
ok('再ログインで失敗chunkだけを補い2件とも残す', largeNotes.every((note) => afterRetry.local.notes.some((local) => local.id === note.id) && afterRetry.remote.notes.some((remote) => remote.id === note.id)), { local: afterRetry.local.notes.map((note) => note.id), remote: afterRetry.remote.notes.map((note) => note.id) });

const manyContext = await browser.newContext({ viewport: { width: 1024, height: 760 } });
const manyNotes = Array.from({ length: 101 }, (_, index) => note(`note-${crypto.randomUUID()}`, [`n${index}`]));
const manyPage = await pageWithAnonymous(manyContext, manyNotes);
const manyUser = `many${Date.now().toString(36)}`;
await signup(manyPage, manyUser);
const capped = await manyPage.evaluate(async () => ({ local: window.__neoApp.getNotes(), remote: await (await fetch('/api/notes')).json(), status: document.getElementById('sync-status').textContent }));
ok('101件目をクラウド上限で止めても端末の101件を保持する', manyNotes.every((note) => capped.local.notes.some((local) => local.id === note.id)) && capped.remote.notes.length === 100 && capped.status.includes('100件上限'), { local: capped.local.notes.length, remote: capped.remote.notes.length, status: capped.status });
await manyPage.locator('.account-close').click();
await manyPage.waitForFunction(() => window.__neoApp.getNotes().activeId !== null);
const beforeNew = await manyPage.evaluate(() => ({
  activeId: window.__neoApp.getNotes().activeId,
}));
await manyPage.click('#new-note');
const afterNew = await manyPage.evaluate(() => ({ notes: window.__neoApp.getNotes(), status: document.getElementById('sync-status').textContent }));
ok('ログイン中の100件到達後は新しいノートを作らない', afterNew.notes.notes.length === capped.local.notes.length && afterNew.notes.activeId === beforeNew.activeId && afterNew.status.includes('100件上限'), { count: afterNew.notes.notes.length, activeId: afterNew.notes.activeId, status: afterNew.status, beforeNew });
await manyPage.click('#notes-toggle');
ok('101件超の端末ノートも過去のノートから閲覧できる', await manyPage.locator('.note-list-item').count() >= 101, await manyPage.locator('.note-list-item').count());

await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
process.exit(failures.length ? 1 : 0);
