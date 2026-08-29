// `wrangler dev --config wrangler.test.jsonc --local --port 8788` を起動後に実行する。
// 拓男報告バグの回帰テスト:「ログインしてもログインボタンが表示されっぱなし」。
// #account-toggle の表示文字が、ID/パスワードログイン・reloadによるセッション復元・
// ログアウトの各経路で正しく切り替わることだけを、実サーバ+実D1+実画面で確認する
// （canvasノート保存等の他機能はlocal-session-restore-smoke.mjsが別途担当）。
import { chromium } from '../../spike/node_modules/playwright/index.mjs';

const base = process.env.SHIKITYPE_LOCAL_BASE || 'http://127.0.0.1:8788/';
const user = `toggle${Date.now().toString(36)}`;
const password = 'local-toggle-label-password-123';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}`, detail); }
}
const toggleState = (page) => page.evaluate(() => ({
  text: document.getElementById('account-toggle').textContent,
  ariaLabel: document.getElementById('account-toggle').getAttribute('aria-label'),
  title: document.getElementById('account-toggle').title,
}));

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1024, height: 760 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  console.log('  step: open (未ログイン初期表示)');
  await page.goto(base, { waitUntil: 'networkidle' });
  const initial = await toggleState(page);
  ok('未ログイン時は「ログイン」表示', initial.text.includes('ログイン') && !initial.text.includes(user), initial);

  console.log('  step: signup (=初回ログイン相当)');
  await page.click('#account-toggle');
  await page.click('#account-tab-signup');
  await page.locator('#signup-id').fill(user);
  await page.locator('#signup-password').fill(password);
  const signupResponse = page.waitForResponse((response) => response.url().includes('/api/auth/signup'), { timeout: 12_000 });
  await page.locator('#signup-password').press('Enter');
  const signup = await signupResponse;
  if (!signup.ok()) throw new Error(`signup failed ${signup.status()}: ${await signup.text()}`);
  await page.waitForFunction((id) => document.getElementById('account-user-id').textContent === id, user);
  const afterSignup = await toggleState(page);
  ok('ログイン成功直後、ボタン表示がIDへ変わる(「ログイン」のまま残らない)', afterSignup.text.includes(user) && !afterSignup.text.includes('ログイン'), afterSignup);
  ok('aria-labelもログイン中の状態を示す', afterSignup.ariaLabel.includes(user), afterSignup);
  ok('titleにも状態を示す(長いIDでも省略時に確認できる)', afterSignup.title.includes(user), afterSignup);
  await page.locator('.account-close').click();

  console.log('  step: reload (セッション復元経路)');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction((id) => document.getElementById('account-user-id').textContent === id, user);
  const afterReload = await toggleState(page);
  ok('reload後(セッション復元)もボタン表示がIDのまま保たれる', afterReload.text.includes(user) && !afterReload.text.includes('ログイン'), afterReload);

  console.log('  step: logout');
  await page.click('#account-toggle');
  await page.click('#logout-submit');
  await page.waitForFunction(() => document.getElementById('account-user-id').textContent === '' && !document.getElementById('account-dialog').open);
  const afterLogout = await toggleState(page);
  ok('ログアウト後、ボタン表示が「ログイン」へ戻る', afterLogout.text.includes('ログイン') && !afterLogout.text.includes(user), afterLogout);
  ok('ログアウト後、aria-labelも未ログイン用へ戻る', afterLogout.ariaLabel === 'ログインまたはアカウント作成', afterLogout);

  console.log('  step: reload (ログアウト後の状態も保たれるか)');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('account-user-id').textContent === '');
  const afterLogoutReload = await toggleState(page);
  ok('ログアウト後にreloadしても「ログイン」表示のまま(誤ってログイン中に戻らない)', afterLogoutReload.text.includes('ログイン') && !afterLogoutReload.text.includes(user), afterLogoutReload);

  ok('画面エラーなし', errors.length === 0, errors);
  await context.close();
} finally {
  await browser.close();
}

console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
