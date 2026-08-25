import { chromium } from '../../spike/node_modules/playwright/index.mjs';

const base = 'http://127.0.0.1:8788/';
const password = 'claim-race-password-123';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}`, detail); } }
function note(id, values) { return { id, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', unitId: 's3-sekibun', rows: Array.isArray(values) ? values : [values], revision: 0 }; }
async function signup(page, id) {
  await page.click('#account-toggle');
  await page.click('#account-tab-signup');
  await page.locator('#signup-id').fill(id);
  await page.locator('#signup-password').fill(password);
  await page.locator('#signup-password').press('Enter');
  await page.waitForFunction((value) => document.getElementById('account-user-id').textContent === value, id);
}
async function login(page, id) {
  await page.click('#account-toggle');
  await page.click('#account-tab-login');
  await page.locator('#login-id').fill(id);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-password').press('Enter');
  await page.waitForFunction((value) => document.getElementById('account-user-id').textContent === value, id);
}
async function logout(page) {
  if (!await page.locator('#account-dialog').evaluate((dialog) => dialog.open)) await page.click('#account-toggle');
  await page.click('#logout-submit');
  await page.waitForFunction(() => document.getElementById('account-user-id').textContent === '');
}
async function cloudNotes(page) {
  return page.evaluate(async () => ({ local: window.__neoApp.getNotes(), remote: await (await fetch('/api/notes')).json() }));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1024, height: 760 } });
const page = await context.newPage();
const first = note(`note-${crypto.randomUUID()}`, Array.from({ length: 31 }, () => 'a'.repeat(3600)));
const second = note(`note-${crypto.randomUUID()}`, Array.from({ length: 31 }, () => 'b'.repeat(3600)));
await page.addInitScript(({ store }) => localStorage.setItem('neo-math.notes.v1', JSON.stringify(store)), { store: { version: 1, activeId: first.id, notes: [first, second] } });
await page.goto(base, { waitUntil: 'networkidle' });

const accountA = `claim-a-${Date.now().toString(36)}`;
const accountB = `claim-b-${Date.now().toString(36)}`;
const requestTrace = [];
page.on('response', async (response) => {
  if (!response.url().includes('/api/notes')) return;
  const body = await response.text().catch(() => '');
  requestTrace.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status(), body: body.slice(0, 240) });
});
await context.route('**/api/notes/import', async (route) => {
  if (route.request().postData()?.includes(second.id)) {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_failure' }) });
    return;
  }
  await route.continue();
});
await signup(page, accountA);
await page.waitForFunction(() => window.__neoApp.getNotes().notes.length === 2 && document.getElementById('sync-status').textContent.includes('同期待ち'));
let aPartial = await cloudNotes(page);
ok('Aの途中失敗でも2件を端末に保持', aPartial.local.notes.length === 2 && aPartial.remote.notes.length === 1, aPartial);

await context.unroute('**/api/notes/import');
await page.reload({ waitUntil: 'domcontentloaded' });
const retryTrace = [];
let reloadCompleted = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const snapshot = await page.evaluate(async () => ({
    status: document.getElementById('sync-status').textContent,
    local: window.__neoApp.getNotes().notes.map((entry) => entry.id),
    remote: (await (await fetch('/api/notes')).json()).notes.map((entry) => entry.id),
  }));
  if (attempt === 0 || attempt % 4 === 3 || [first.id, second.id].every((id) => snapshot.remote.includes(id))) {
    retryTrace.push({ attempt, ...snapshot });
  }
  if ([first.id, second.id].every((id) => snapshot.remote.includes(id))) { reloadCompleted = true; break; }
  await page.waitForTimeout(250);
}
aPartial = await cloudNotes(page);
const hasOriginals = (notes) => [first.id, second.id].every((id) => notes.some((note) => note.id === id));
ok('再読込後もAだけが失敗分を再開できる', reloadCompleted && hasOriginals(aPartial.local.notes) && hasOriginals(aPartial.remote.notes), {
  local: aPartial.local.notes.map((entry) => entry.id),
  remote: aPartial.remote.notes.map((entry) => entry.id),
  retryTrace,
  requestTrace,
});

await logout(page);
await page.waitForFunction(() => window.__neoApp.getNotes().notes.length === 0);
ok('logout中はAがclaimした匿名ノートを表示しない', true);
await signup(page, accountB);
await page.waitForFunction(() => window.__neoApp.getNotes().notes.length === 0);
const bEmpty = await cloudNotes(page);
ok('B signupへAのclaim済みノートを渡さない', bEmpty.local.notes.length === 0 && bEmpty.remote.notes.length === 0, bEmpty);
await logout(page);
await login(page, accountA);
await page.waitForTimeout(800);
const aRestored = await cloudNotes(page);
ok('A再ログインで失敗分を補完し全件復元', hasOriginals(aRestored.local.notes) && hasOriginals(aRestored.remote.notes), aRestored);

await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
process.exit(failures.length ? 1 : 0);
