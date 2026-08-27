// `wrangler dev --config wrangler.test.jsonc --local --port 8788` を起動後に実行する。
// CDPの仮想認証器（WebAuthn domain）を使い、実機の生体認証なしでも
// navigator.credentials.create/get を実際のWebAuthn署名検証まで通す。
// 構文チェックやAPIのユニットテストだけでは「登録した鍵で本当にログインし直せるか」を
// 確認できないため、実ブラウザ経路での検証をここに置く。
import { chromium } from '../../spike/node_modules/playwright/index.mjs';

const base = process.env.SHIKITYPE_LOCAL_BASE || 'http://127.0.0.1:8788/';
const user = `passkey${Date.now().toString(36)}`;
const password = 'local-passkey-password-123';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}`, JSON.stringify(detail)); }
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1024, height: 760 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  console.log('  step: open + signup (password account, パスキーはこの上に追加登録する)');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.click('#account-toggle');
  await page.click('#account-tab-signup');
  await page.locator('#signup-id').fill(user);
  await page.locator('#signup-password').fill(password);
  const signupResponse = page.waitForResponse((response) => response.url().includes('/api/auth/signup'));
  await page.locator('#signup-password').press('Enter');
  const signup = await signupResponse;
  if (!signup.ok()) throw new Error(`signup failed ${signup.status()}: ${await signup.text()}`);
  await page.waitForFunction((id) => document.getElementById('account-user-id').textContent === id, user);

  console.log('  step: register a passkey via UI (仮想認証器で実際の attestation を作らせる)');
  const registerButtonVisible = await page.locator('#passkey-register-submit').isVisible();
  ok('パスキー対応ブラウザとして登録ボタンが見えている', registerButtonVisible);
  const verifyResponse = page.waitForResponse((response) => response.url().includes('/api/auth/passkey/register/verify'));
  await page.click('#passkey-register-submit');
  const verify = await verifyResponse;
  ok('register/verify がサーバ側の署名検証を通って200を返す', verify.ok(), { status: verify.status(), body: await verify.text().catch(() => null) });
  const credentialsAfterRegister = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  ok('仮想認証器に1件のresident keyが実際に作られた', credentialsAfterRegister.credentials.length === 1, credentialsAfterRegister.credentials);
  await page.waitForFunction(() => document.getElementById('account-message').textContent.includes('登録しました'));

  console.log('  step: logout');
  await page.click('.account-close');
  await page.click('#account-toggle');
  await page.click('#logout-submit');
  await page.waitForFunction(() => document.getElementById('account-toggle').textContent.includes('ログイン'));

  console.log('  step: passkey login (discoverable credential, ログインIDを渡さない)');
  await page.click('#account-toggle');
  const loginButtonVisible = await page.locator('#passkey-login').isVisible();
  ok('ログインパネルにパスキーボタンが見えている', loginButtonVisible);
  const loginVerifyResponse = page.waitForResponse((response) => response.url().includes('/api/auth/passkey/login/verify'));
  await page.click('#passkey-login');
  const loginVerify = await loginVerifyResponse;
  ok('login/verify が実際の署名検証を通って200を返し、セッションcookieを発行する', loginVerify.ok() && Boolean(loginVerify.headers()['set-cookie']), { status: loginVerify.status(), setCookie: loginVerify.headers()['set-cookie'] });
  await page.waitForFunction((id) => document.getElementById('account-user-id')?.textContent === id, user);
  const me = await page.evaluate(async () => (await fetch('/api/auth/me', { credentials: 'same-origin' })).json());
  ok('パスキーでログインし直した後、/api/auth/meが同じアカウントを返す', me.user?.id === user, me);

  console.log('  step: 未知のcredentialでのログインは401で弾かれ、セッションが増えない');
  const rejected = await page.evaluate(async () => {
    const optionsResponse = await fetch('/api/auth/passkey/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { challengeId } = await optionsResponse.json();
    const verifyResponse = await fetch('/api/auth/passkey/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, credential: { id: 'not-a-real-credential-id', rawId: 'not-a-real-credential-id', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'e30', signature: 'e30' } } }),
    });
    return { status: verifyResponse.status, setCookie: verifyResponse.headers.get('Set-Cookie') };
  });
  ok('未登録credentialのログイン試行は401で、Set-Cookieも発行しない', rejected.status === 401 && !rejected.setCookie, rejected);

  ok('ページエラーなし', pageErrors.length === 0, pageErrors);

  await context.close();
} finally {
  await browser.close();
}
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
