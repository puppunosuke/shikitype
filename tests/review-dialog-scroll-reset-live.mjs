// AI見直しダイアログの見出し位置を、実Worker・実dialogのスクロールで確認する回帰テスト。
// OpenAI 応答だけは route で差し替え、履歴→結果、別の見直し、進行表示の遷移を実DOMで通す。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const base = process.env.REVIEW_SCROLL_BASE || 'http://127.0.0.1:8788/';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed += 1; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

const fakeResult = {
  runId: 'scroll-reset-history',
  reviewKind: 'hint',
  mode: 'pipeline',
  card: { strengths: ['式の形を保てています。'], corrections: [{ blockId: null, text: '係数だけを確かめてください。' }], nextStep: '展開した定数項を一つずつ比べよう。' },
  conversation: [
    { label: '解法担当', message: '別の方法で確認しました。' },
    { label: '照合担当', message: '次の一手を小さくしました。' },
  ],
  chat: [],
  snapshot: [],
  createdAt: new Date().toISOString(),
};

async function topState(page) {
  return page.evaluate(() => {
    const dialog = document.getElementById('review-dialog');
    const title = document.getElementById('review-dialog-title');
    const dialogBox = dialog.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    return { scrollTop: dialog.scrollTop, titleOffset: titleBox.top - dialogBox.top };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  const userId = `scroll${Date.now().toString(36)}`;
  await page.click('#account-toggle');
  await page.click('#account-tab-signup');
  await page.fill('#signup-id', userId);
  await page.fill('#signup-password', 'review-scroll-reset-123');
  await page.click('#signup-submit');
  await page.waitForFunction(() => !document.getElementById('recovery-code-panel').hidden, undefined, { timeout: 5000 });
  await page.click('.account-close');

  await page.evaluate(() => window.__neoApp.newNote());
  await page.waitForTimeout(250);
  await page.click('math-field');
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    row.mf.value = 'x^2'; row.mf.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(900);

  await page.route('**/api/notes/*/reviews', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ reviews: [{ ...fakeResult, result: fakeResult, snapshot: [] }] }),
  }));
  await page.click('#review-toggle');
  await page.waitForSelector('.review-history-item', { state: 'attached', timeout: 5000 });
  await page.evaluate(() => {
    const dialog = document.getElementById('review-dialog');
    const filler = document.createElement('div');
    filler.style.height = '1500px'; filler.dataset.test = 'history-scroll-filler';
    document.getElementById('review-setup').append(filler);
    dialog.scrollTop = dialog.scrollHeight;
  });
  await page.locator('#review-history summary').click();
  await page.waitForSelector('.review-history-item', { state: 'visible', timeout: 5000 });
  await page.locator('.review-history-item').click();
  await page.waitForTimeout(80);
  const historyResultTop = await topState(page);
  const historyResultVisible = await page.evaluate(() => !document.getElementById('review-result').hidden);
  ok('履歴から結果を開くと、dialog自身を先頭へ戻して見出しが最上部に見える', historyResultVisible && historyResultTop.scrollTop === 0 && historyResultTop.titleOffset >= 0 && historyResultTop.titleOffset < 90, { historyResultVisible, ...historyResultTop });

  await page.evaluate(() => {
    const dialog = document.getElementById('review-dialog');
    const filler = document.createElement('div');
    filler.style.height = '1500px'; filler.dataset.test = 'result-scroll-filler';
    document.getElementById('review-result').append(filler);
    dialog.scrollTop = dialog.scrollHeight;
  });
  await page.click('#review-again');
  await page.waitForTimeout(80);
  const nextReviewTop = await topState(page);
  const nextReviewFocus = await page.evaluate(() => ({ setupVisible: !document.getElementById('review-setup').hidden, focusedProblem: document.activeElement?.id === 'review-problem' }));
  ok('別の見直しへ戻る時も、問題文へフォーカスしつつ見出しから読める', nextReviewFocus.setupVisible && nextReviewFocus.focusedProblem && nextReviewTop.scrollTop === 0 && nextReviewTop.titleOffset >= 0 && nextReviewTop.titleOffset < 90, { ...nextReviewFocus, ...nextReviewTop });

  let releaseReview;
  const reviewGate = new Promise((resolve) => { releaseReview = resolve; });
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await reviewGate;
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...fakeResult, runId: 'scroll-reset-progress', noteId: body.noteId, noteUpdatedAt: body.noteUpdatedAt }) });
  });
  await page.fill('#review-problem', 'x^2を確認する');
  await page.evaluate(() => {
    const dialog = document.getElementById('review-dialog');
    dialog.scrollTop = dialog.scrollHeight;
  });
  await page.click('#review-submit');
  await page.waitForSelector('#review-progress:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(80);
  const progressTop = await topState(page);
  const progressFocus = await page.evaluate(() => document.activeElement?.id === 'review-progress-status');
  ok('進行表示へ切り替えても、進行状態へフォーカスしながら見出しを押し流さない', progressFocus && progressTop.scrollTop === 0 && progressTop.titleOffset >= 0 && progressTop.titleOffset < 90, { progressFocus, ...progressTop });
  releaseReview();
  await page.waitForSelector('#review-result:not([hidden])', { timeout: 5000 });

  await page.setViewportSize({ width: 390, height: 760 });
  const narrow = await topState(page);
  const horizontalOverflow = await page.evaluate(() => document.getElementById('review-dialog').scrollWidth > document.getElementById('review-dialog').clientWidth);
  ok('390pxでも結果見出しは最上部にあり横スクロールを作らない', narrow.scrollTop === 0 && narrow.titleOffset >= 0 && narrow.titleOffset < 90 && !horizontalOverflow, { ...narrow, horizontalOverflow });

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
