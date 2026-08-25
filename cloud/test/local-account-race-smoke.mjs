import { chromium } from '../../spike/node_modules/playwright/index.mjs';

const base = 'http://127.0.0.1:8788/';
const password = 'account-race-password-123';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}`, detail); } }
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

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1024, height: 760 } });
const page = await context.newPage();
const accountC = `race-c-${Date.now().toString(36)}`;
const accountD = `race-d-${Date.now().toString(36)}`;
const cNote = { id: `note-${crypto.randomUUID()}`, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', unitId: 's3-sekibun', rows: ['c-account-only'], revision: 0 };
const cDictionaryCsv = 'version,operation,candidate_id,symbol,latex,reading,base_priority\n1,upsert,custom-delta,Δ,\\Delta,でるた,360\n';

await page.goto(base, { waitUntil: 'networkidle' });
await signup(page, accountC);
await page.evaluate((csv) => {
  const result = window.__neoApp.importConversionDictionaryText(csv);
  if (result.accepted !== 1) throw new Error(`dictionary import rejected: ${JSON.stringify(result)}`);
  window.__neoApp.setConversionManualPriority('custom-delta', 20);
}, cDictionaryCsv);
await page.waitForFunction(async () => {
  const response = await fetch('/api/conversion-profile');
  const body = await response.json();
  return body.profile?.dictionary?.additions?.['custom-delta'] && body.profile?.manual?.priorities?.['custom-delta'] === 20;
});
const cProfile = await page.evaluate(() => ({ dictionary: window.__neoApp.getConversionDictionary(), manual: window.__neoApp.getConversionPreferences().manual }));
ok('AのCSV辞書と手動順位はアカウントプロファイルへ保存する', !!cProfile.dictionary.additions['custom-delta'] && cProfile.manual.priorities['custom-delta'] === 20, cProfile);
ok('ログイン直後の辞書UIはAのクラウド保存先を示す', (await page.locator('#conversion-dictionary-storage').textContent()).includes(`保存先：${accountC} のクラウド`));
await page.evaluate(async (note) => {
  const response = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(note) });
  if (!response.ok) throw new Error(`seed C ${response.status}`);
}, cNote);
await logout(page);
await signup(page, accountD);
const dProfile = await page.evaluate(async () => ({
  local: { dictionary: window.__neoApp.getConversionDictionary(), manual: window.__neoApp.getConversionPreferences().manual },
  remote: await (await fetch('/api/conversion-profile')).json(),
}));
ok('BにはAの辞書・手動順位を見せない', !dProfile.local.dictionary.additions['custom-delta'] && dProfile.local.manual.priorities['custom-delta'] === undefined && !dProfile.remote.profile.dictionary.additions['custom-delta'], dProfile);
ok('A→Bの切替直後に辞書UIの保存先もBへ変わる', (await page.locator('#conversion-dictionary-storage').textContent()).includes(`保存先：${accountD} のクラウド`));
await logout(page);
await login(page, accountC);
await page.waitForFunction(() => window.__neoApp.getConversionDictionary().additions['custom-delta'] && window.__neoApp.getConversionPreferences().manual.priorities['custom-delta'] === 20);
const restoredCProfile = await page.evaluate(() => ({ dictionary: window.__neoApp.getConversionDictionary(), manual: window.__neoApp.getConversionPreferences().manual }));
ok('A→B→AでAの辞書・手動順位を復元する', !!restoredCProfile.dictionary.additions['custom-delta'] && restoredCProfile.manual.priorities['custom-delta'] === 20, restoredCProfile);
ok('B→Aの切替直後に辞書UIの保存先もAへ戻る', (await page.locator('#conversion-dictionary-storage').textContent()).includes(`保存先：${accountC} のクラウド`));

// 先行PUTの応答を待っている間に編集した値は、先行snapshotで画面を戻さず
// 新しいrevisionを使って再送する。後発PUTのACK後に先行PUTを解放すると409に
// なるため、その古い409で成功済みのdirty/conflict表示を戻さないことも検証する。
let heldProfilePut = false;
let releaseProfilePut;
const profilePutHeld = new Promise((resolve) => { releaseProfilePut = resolve; });
let profilePutStarted;
const profilePutStartedPromise = new Promise((resolve) => { profilePutStarted = resolve; });
await context.route('**/api/conversion-profile', async (route) => {
  if (route.request().method() === 'PUT' && !heldProfilePut) {
    heldProfilePut = true;
    profilePutStarted();
    await profilePutHeld;
  }
  await route.continue();
});
await page.evaluate(() => window.__neoApp.setConversionManualPriority('sum-operator', 11));
await profilePutStartedPromise;
await page.evaluate(() => window.__neoApp.setConversionManualPriority('greek-alpha', 12));
await page.waitForFunction(async () => {
  const profile = (await (await fetch('/api/conversion-profile')).json()).profile;
  return profile?.manual?.priorities?.['sum-operator'] === 11
    && profile.manual.priorities?.['greek-alpha'] === 12;
});
releaseProfilePut();
await page.waitForTimeout(400);
const afterInFlightEdit = await page.evaluate(() => ({
  manual: window.__neoApp.getConversionPreferences().manual,
  storage: document.getElementById('conversion-dictionary-storage').textContent,
  meta: JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith('neo-math.conversion-profile-meta.v1.user.')) || '') || 'null'),
}));
ok('遅延PUTの409で後発ACK済み編集を競合表示へ戻さない', heldProfilePut && afterInFlightEdit.manual.priorities['sum-operator'] === 11 && afterInFlightEdit.manual.priorities['greek-alpha'] === 12 && afterInFlightEdit.meta?.dirty === false && !afterInFlightEdit.storage.includes('競合'), afterInFlightEdit);
await context.unroute('**/api/conversion-profile');

// PUT失敗後にページを読込み直しても、base revisionが同じremoteなら未送信の
// dictionary/manualを残して再送する。learningは端末だけに残ることも同時に確認する。
if (await page.locator('#account-dialog').evaluate((dialog) => dialog.open)) await page.locator('.account-close').click();
await page.evaluate(() => window.__neoApp.setInputSystem('conversion', false));
await page.locator('math-field').first().focus();
await page.keyboard.type('siguma');
await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
const learningBeforeOffline = await page.evaluate(() => window.__neoApp.getConversionPreferences().learning);
let rejectedOfflinePut = false;
await context.route('**/api/conversion-profile', async (route) => {
  if (route.request().method() === 'PUT' && !rejectedOfflinePut) {
    rejectedOfflinePut = true;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'offline_for_test' }) });
    return;
  }
  await route.continue();
});
await page.evaluate(() => window.__neoApp.setConversionManualPriority('greek-sigma', 41));
await page.waitForFunction(() => document.getElementById('conversion-dictionary-storage').textContent.includes('オフライン'));
await context.unroute('**/api/conversion-profile');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(async () => (await (await fetch('/api/conversion-profile')).json()).profile?.manual?.priorities?.['greek-sigma'] === 41);
const afterOfflineReload = await page.evaluate(() => ({
  dictionary: window.__neoApp.getConversionDictionary(),
  preferences: window.__neoApp.getConversionPreferences(),
  meta: JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith('neo-math.conversion-profile-meta.v1.user.')) || '') || 'null'),
}));
ok('PUT失敗→reloadでも未送信辞書・手動順位・端末内学習を保持して再送する', rejectedOfflinePut && !!afterOfflineReload.dictionary.additions['custom-delta'] && afterOfflineReload.preferences.manual.priorities['greek-sigma'] === 41 && JSON.stringify(afterOfflineReload.preferences.learning) === JSON.stringify(learningBeforeOffline) && afterOfflineReload.meta?.dirty === false, afterOfflineReload);

// 別端末相当のremote更新が進んだ場合は、dirty localをremoteで黙って置き換えない。
let rejectedConflictPut = false;
await context.route('**/api/conversion-profile', async (route) => {
  if (route.request().method() === 'PUT' && !rejectedConflictPut) {
    rejectedConflictPut = true;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'offline_for_conflict_test' }) });
    return;
  }
  await route.continue();
});
await page.evaluate(() => window.__neoApp.setConversionManualPriority('greek-sigma', 49));
await page.waitForFunction(() => document.getElementById('conversion-dictionary-storage').textContent.includes('オフライン'));
await context.unroute('**/api/conversion-profile');
await page.evaluate(async () => {
  const current = await (await fetch('/api/conversion-profile')).json();
  const manual = { ...current.profile.manual, priorities: { ...current.profile.manual.priorities, 'sum-operator': 33 } };
  const response = await fetch('/api/conversion-profile', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dictionary: current.profile.dictionary, manual, revision: current.profile.revision, idempotencyKey: `other-device-${crypto.randomUUID()}` }),
  });
  if (!response.ok) throw new Error(`remote conflict seed failed: ${response.status}`);
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('conversion-dictionary-storage').textContent.includes('競合'));
const conflictState = await page.evaluate(async () => ({
  local: window.__neoApp.getConversionPreferences().manual,
  remote: await (await fetch('/api/conversion-profile')).json(),
  storage: document.getElementById('conversion-dictionary-storage').textContent,
  message: document.getElementById('conversion-dictionary-status').textContent,
}));
ok('remote版が進んだdirty reloadはローカル順位を保持して競合を表示する', rejectedConflictPut && conflictState.local.priorities['greek-sigma'] === 49 && conflictState.remote.profile.manual.priorities['sum-operator'] === 33 && conflictState.storage.includes('競合') && conflictState.message.includes('ローカルの辞書は保持'), conflictState);
await page.click('#account-toggle');
await page.click('#logout-submit');
await page.waitForFunction(() => document.getElementById('account-user-id').textContent === '');
await login(page, accountC);

// Aで発生した未送信タイマーは、ログアウト後にBの資格情報・状態を使って送られない。
// 120msの保存待ちより先にA→Bへ切り替え、B宛てのPUT本文を実測する。
const delayedProfileBodies = [];
await context.route('**/api/conversion-profile', async (route) => {
  if (route.request().method() === 'PUT') delayedProfileBodies.push(route.request().postData() || '');
  await route.continue();
});
await page.evaluate(() => window.__neoApp.setConversionManualPriority('greek-sigma', 47));
await logout(page);
await login(page, accountD);
await page.waitForTimeout(260);
const dAfterPendingA = await page.evaluate(async () => ({
  local: window.__neoApp.getConversionPreferences().manual,
  remote: await (await fetch('/api/conversion-profile')).json(),
}));
ok('未送信Aの辞書更新をBへ送らない', !delayedProfileBodies.some((body) => body.includes('"greek-sigma":47')) && dAfterPendingA.local.priorities['greek-sigma'] === undefined && dAfterPendingA.remote.profile.manual.priorities['greek-sigma'] === undefined, { delayedProfileBodies, dAfterPendingA });
await context.unroute('**/api/conversion-profile');
await logout(page);
await login(page, accountC);

let heldMe = false;
let releaseMe;
const meHeld = new Promise((resolve) => { releaseMe = resolve; });
let meStarted;
const meStartedPromise = new Promise((resolve) => { meStarted = resolve; });
const sentCToD = [];
await context.route('**/api/auth/me', async (route) => {
  if (!heldMe) {
    heldMe = true;
    meStarted();
    await meHeld;
  }
  await route.continue();
});
await context.route('**/api/notes/**', async (route) => {
  const body = route.request().postData() || '';
  if (body.includes(cNote.id)) sentCToD.push({ method: route.request().method(), url: route.request().url() });
  await route.continue();
});

await page.reload({ waitUntil: 'domcontentloaded' });
await meStartedPromise;
await page.click('#account-toggle');
await page.click('#account-tab-login');
await page.locator('#login-id').fill(accountD);
await page.locator('#login-password').fill(password);
await page.locator('#login-password').press('Enter');
const disabledDuringSubmit = await page.locator('.account-submit').evaluateAll((buttons) => buttons.every((button) => button.disabled));
// 同じフォーム送信を重ねても1操作に畳まれる（submit中のボタンは無効）。
await page.locator('#login-password').press('Enter');
await page.waitForFunction((value) => document.getElementById('account-user-id').textContent === value, accountD);
releaseMe();
await page.waitForTimeout(800);
const finalState = await page.evaluate(async () => ({
  user: document.getElementById('account-user-id').textContent,
  local: window.__neoApp.getNotes(),
  remote: await (await fetch('/api/notes')).json(),
}));
ok('送信中はアカウント操作をsingle-flightにする', disabledDuringSubmit);
ok('遅延したCのrestore後も最終ログインDだけを表示する', finalState.user === accountD && !finalState.local.notes.some((note) => note.id === cNote.id), finalState);
ok('DへCのノートを送信しない', finalState.remote.notes.length === 0 && sentCToD.length === 0, { remote: finalState.remote, sentCToD });

await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
process.exit(failures.length ? 1 : 0);
