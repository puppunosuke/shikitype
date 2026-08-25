// `wrangler dev --config wrangler.test.jsonc --local --port 8788` を起動後に実行する。
// reload 時にも UI のアカウント表示・クラウドノート・キャンバス状態が同じ session
// から復元され、続けて logout できることを実画面で確認する。
import { chromium } from '../../spike/node_modules/playwright/index.mjs';

const base = process.env.SHIKITYPE_LOCAL_BASE || 'http://127.0.0.1:8788/';
const user = `restore${Date.now().toString(36)}`;
const password = 'local-restore-password-123';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}`, detail); }
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1024, height: 760 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  console.log('  step: open');
  await page.goto(base, { waitUntil: 'networkidle' });
  console.log('  step: signup');
  await page.click('#account-toggle');
  await page.click('#account-tab-signup');
  await page.locator('#signup-id').fill(user);
  await page.locator('#signup-password').fill(password);
  const signupStartedAt = Date.now();
  const signupResponse = page.waitForResponse((response) => response.url().includes('/api/auth/signup'), { timeout: 12_000 });
  await page.locator('#signup-password').press('Enter');
  const signup = await signupResponse;
  console.log(`  step: signup response ${signup.status()} in ${Date.now() - signupStartedAt}ms`);
  if (!signup.ok()) throw new Error(`signup failed ${signup.status()}: ${await signup.text()}`);
  await page.waitForFunction((id) => document.getElementById('account-user-id').textContent === id, user);
  if (await page.locator('#account-dialog').evaluate((dialog) => dialog.open)) await page.locator('.account-close').click();

  console.log('  step: canvas save');
  await page.evaluate(() => window.__neoApp.setLayoutMode('canvas'));
  const viewport = page.locator('#canvas-viewport');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('canvas viewport is unavailable');
  const before = await page.evaluate(() => window.__neoApp.rows.length);
  await page.mouse.click(box.x + Math.min(620, box.width - 50), box.y + Math.min(340, box.height - 50));
  await page.waitForFunction((count) => window.__neoApp.rows.length === count + 1, before);
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    row.mf.value = 'x^2';
    row.mf.position = row.mf.lastOffset;
    window.__neoApp.saveNote();
  });
  await page.waitForFunction(async () => {
    const body = await (await fetch('/api/notes')).json();
    return body.notes?.some((note) => note.layout?.mode === 'canvas' && note.layout.blocks?.some((block) => block.latex.includes('x^2')));
  });
  const saved = await page.evaluate(() => ({ camera: window.__neoApp.getCanvasCamera(), blocks: window.__neoApp.getCanvasBlocks() }));

  console.log('  step: reload');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction((id) => document.getElementById('account-user-id').textContent === id, user);
  await page.waitForFunction(() => window.__neoApp.getLayoutMode() === 'canvas' && window.__neoApp.getCanvasBlocks().some((block) => block.latex.includes('x^2')));
  const restored = await page.evaluate(() => ({
    displayedUser: document.getElementById('account-user-id').textContent,
    mode: window.__neoApp.getLayoutMode(),
    camera: window.__neoApp.getCanvasCamera(),
    blocks: window.__neoApp.getCanvasBlocks(),
  }));
  ok('reload後もアカウントIDを表示する', restored.displayedUser === user, restored);
  ok('reload後もクラウドのキャンバスノートを復元する', restored.mode === 'canvas' && restored.blocks.some((block) => block.latex.includes('x^2')) && restored.camera.zoom === saved.camera.zoom, { saved, restored });

  while (await page.locator('.row-delete').count()) {
    await page.locator('.row-delete').last().click();
    await page.waitForTimeout(20);
  }
  await page.evaluate(() => window.__neoApp.saveNote());
  await page.waitForFunction(async () => {
    const body = await (await fetch('/api/notes')).json();
    return body.notes?.some((note) => note.layout?.mode === 'canvas' && note.rows.length === 0 && note.layout.blocks.length === 0);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction((id) => document.getElementById('account-user-id').textContent === id, user);
  const emptyRestored = await page.evaluate(() => ({ mode: window.__neoApp.getLayoutMode(), rows: window.__neoApp.rows.length, blocks: window.__neoApp.getCanvasBlocks() }));
  ok('既存canvasの最後の削除をクラウドへ保存して0 blockで復元する', emptyRestored.mode === 'canvas' && emptyRestored.rows === 0 && emptyRestored.blocks.length === 0, emptyRestored);

  await page.evaluate(() => {
    window.__neoApp.newNote();
    const row = window.__neoApp.getActiveRow();
    row.mf.value = 'a'; row.mf.position = row.mf.lastOffset;
    window.__neoApp.saveNote();
    row.mf.value = ''; row.mf.position = 0;
    window.__neoApp.saveNote();
  });
  await page.waitForFunction(async () => {
    const body = await (await fetch('/api/notes')).json();
    return body.notes?.some((note) => note.layout?.mode === 'rows' && note.rows.length === 1 && note.rows[0] === '');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__neoApp.getLayoutMode() === 'rows' && window.__neoApp.rows.length === 1 && window.__neoApp.getActiveRow().mf.value === '');
  ok('既存rowsの最後の空blockもクラウド保存後に復元する', true);

  console.log('  step: logout');
  await page.click('#account-toggle');
  await page.click('#logout-submit');
  await page.waitForFunction(() => document.getElementById('account-user-id').textContent === '' && !document.getElementById('account-dialog').open);
  ok('復元済みセッションからログアウトできる', true);
  ok('画面エラーなし', errors.length === 0, errors);
  await context.close();
} finally {
  await browser.close();
}

console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exitCode = 1;
