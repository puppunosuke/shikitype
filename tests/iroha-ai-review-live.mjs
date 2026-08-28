// Iroha review — drives the REAL submitReview()/openReviewDialog() code path against a
// hand-rolled mock of /api/* (no wrangler/D1 needed), so we can observe actual loading/
// failure UI, not a DOM simulation. Only /api/reviews' timing/outcome is varied per run;
// everything else is a minimal but real fetch round-trip through the app's own apiJson().
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const base = 'http://127.0.0.1:8893/';
const mode = process.argv[2] || 'slow'; // slow | fail | success

let userId = null;
let noteRevision = 0;
let noteUpdatedAt = new Date().toISOString();

async function setupRoutes(page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/auth/signup', async (route) => {
    userId = 'u-' + Date.now().toString(36);
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ user: { id: userId }, recoveryCode: 'FAKE-0000' }) });
  });
  await page.route('**/api/notes/import', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/notes', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notes: [], activeId: null }) });
  });
  await page.route('**/api/conversion-profile', (route) => {
    const m = route.request().method();
    if (m === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profile: null }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profile: { dictionary: {}, manual: {}, revision: 1 } }) });
  });
  await page.route('**/api/notes/*', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    try {
      noteRevision += 1;
      noteUpdatedAt = new Date().toISOString();
      const raw = route.request().postData();
      console.log('PUT postData:', raw);
      const body = JSON.parse(raw || '{}');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ note: { ...body, revision: noteRevision, updatedAt: noteUpdatedAt } }) });
      console.log('PUT fulfilled ok');
    } catch (err) {
      console.log('PUT route handler error:', err);
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    }
  });
  await page.route('**/api/notes/*/reviews', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reviews: [] }) });
  });
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (mode === 'slow') {
      await new Promise((r) => setTimeout(r, 9000)); // realistic multi-stage LLM pipeline latency
    }
    if (mode === 'fail') {
      await new Promise((r) => setTimeout(r, 1200));
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'review_failed' }) });
    }
    const body = JSON.parse(route.request().postData() || '{}');
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
      runId: 'run-1', noteId: body.noteId, noteUpdatedAt: body.noteUpdatedAt, reviewKind: body.reviewKind, mode: body.mode,
      card: { strengths: ['置換の発想は正しいです。'], corrections: [{ blockId: null, text: '2行目の係数を見直してください。' }], nextStep: '置換後の微分を一行だけ確かめよう。' },
      stages: [{ stage: 'independent_solver' }, { stage: 'solution_auditor' }, { stage: 'falsifier', skipped: true, reason: '省略' }, { stage: 'tutor' }],
      createdAt: new Date().toISOString(),
    }) });
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const events = [];
  page.on('console', (m) => { if (m.type() === 'error') events.push('console:' + m.text()); });
  page.on('pageerror', (e) => events.push('pageerror:' + e));
  page.on('request', (r) => { if (r.url().includes('/api/')) console.log('REQSTART', r.method(), r.url()); });
  page.on('requestfinished', (r) => { if (r.url().includes('/api/')) console.log('REQ', r.method(), r.url()); });
  page.on('requestfailed', (r) => { if (r.url().includes('/api/')) console.log('REQFAIL', r.method(), r.url(), r.failure()); });
  await setupRoutes(page);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  // real signup through the actual UI
  await page.click('#account-toggle');
  await page.click('#account-tab-signup');
  await page.fill('#signup-id', 'e2e' + Date.now());
  await page.fill('#signup-password', 'password-123456');
  await page.click('#signup-submit');
  await page.waitForTimeout(600);
  await page.click('.account-close').catch(() => {});

  // real formula entry
  await page.click('math-field').catch(() => {});
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    row.mf.value = '\\int 2x\\,dx';
    row.mf.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  await page.click('#review-toggle');
  await page.waitForTimeout(150);
  await page.fill('#review-problem', '∫2x dx を求めよ');

  // Can we do something else while it's in flight? Try clicking the note area / typing.
  const clickPromise = page.click('#review-submit');
  await page.waitForTimeout(2500);
  const midFlightState = await page.evaluate(() => ({
    submitDisabled: document.getElementById('review-submit').disabled,
    statusText: document.getElementById('review-status').textContent,
    dialogModal: document.getElementById('review-dialog').open,
    bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
    canFocusOutsideDialog: (() => { try { document.getElementById('review-dialog-close').blur(); const mf = document.querySelector('math-field'); mf?.focus(); return document.activeElement === mf; } catch { return null; } })(),
  }));
  console.log(`[${mode}] mid-flight state @600ms:`, midFlightState);
  await page.screenshot({ path: `F:/12_Claude/Claude/neo-math-solution/tests/iroha-shots-ai-review/live-${mode}-midflight.png` });

  if (mode === 'slow') {
    await page.waitForTimeout(4000);
    const stillWaiting = await page.evaluate(() => document.getElementById('review-status').textContent);
    console.log(`[${mode}] status text still at 4.6s elapsed:`, stillWaiting, '(unchanged since submit = no progress feedback)');
    await page.screenshot({ path: `F:/12_Claude/Claude/neo-math-solution/tests/iroha-shots-ai-review/live-${mode}-still-waiting.png` });
  }

  await clickPromise;
  await page.waitForTimeout(400);
  const finalState = await page.evaluate(() => ({
    resultVisible: !document.getElementById('review-result').hidden,
    statusText: document.getElementById('review-status').textContent,
    statusIsError: document.getElementById('review-status').dataset.error,
    submitDisabled: document.getElementById('review-submit').disabled,
  }));
  console.log(`[${mode}] final state:`, finalState);
  await page.screenshot({ path: `F:/12_Claude/Claude/neo-math-solution/tests/iroha-shots-ai-review/live-${mode}-final.png` });

  console.log(`[${mode}] page errors:`, events);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
