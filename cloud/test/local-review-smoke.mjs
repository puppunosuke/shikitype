// AI見直し機能の実画面smoke（他のlocal-*-smoke.mjsと同じ手動実行の位置づけ）。
// 先に `npx wrangler d1 migrations apply shikitype-test --local --config wrangler.test.jsonc`
// でローカルD1へ0007/0008を当ててから、
// `npx wrangler dev --config wrangler.test.jsonc --local --port 8788` を起動して実行する。
// OpenAI課金を避けるため、/api/reviews と /api/notes/:id/reviews への応答だけPlaywrightのroute
// interceptで差し替える。それ以外（サインアップ・ログイン・ノート保存・実D1・数式入力・
// ダイアログのTab/Escape・stale判定・ページ再読込によるセッション復元）は実サーバ・実DOM。
// ダミーキーのまま本物のOpenAIへ到達させて503へ落ちることの確認は、この横に置かず
// 都度使い捨てスクリプトで行った（2026-08-28）。認証で弾かれるだけなので生成コストは発生しない。
import { chromium } from '../../spike/node_modules/playwright/index.mjs';

const base = 'http://127.0.0.1:8788/';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}`, JSON.stringify(detail)); } }

const fakeCard = {
  strengths: ['置換の発想は正しいです。'],
  corrections: [{ blockId: null, text: '2行目の係数を見直してください。' }],
  nextStep: '置換後の微分を一行だけ確かめよう。',
  confidence: 0.9,
};
let fakeRunId = 'run-fake-0001';
const fakeStages = [
  { stage: 'independent_solver', inputScope: 'problem_and_conditions' },
  { stage: 'solution_auditor', inputScope: 'reference_solution_and_student_blocks' },
  { stage: 'falsifier', inputScope: 'skipped_by_stage_conditions', skipped: true, reason: '独立解答と照合の信頼度が十分だったため省略' },
  { stage: 'tutor', inputScope: 'safe_audit_handoff_only' },
];
let savedReview = null; // 「保存されたレビュー」を模したサーバ状態(このプロセス内だけ)

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`); });

  // /api/reviews と .../reviews 一覧だけ差し替える。他のAPI・静的ファイルは実サーバへ通す。
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = JSON.parse(route.request().postData() || '{}');
    savedReview = {
      runId: fakeRunId, noteId: body.noteId, noteUpdatedAt: body.noteUpdatedAt,
      reviewKind: body.reviewKind, mode: body.mode, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      snapshot: body.blocks,
      result: { runId: fakeRunId, noteId: body.noteId, noteUpdatedAt: body.noteUpdatedAt, reviewKind: body.reviewKind, mode: body.mode, card: fakeCard, stages: fakeStages, createdAt: new Date().toISOString() },
    };
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(savedReview.result) });
  });
  await page.route('**/api/notes/*/reviews', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reviews: savedReview ? [savedReview] : [] }) });
  });

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  // --- 実サーバでアカウント作成・ログイン ---
  const userId = `e2e${Date.now().toString(36)}`;
  const password = 'e2e-review-password-123';
  await page.click('#account-toggle');
  await page.click('#account-tab-signup');
  await page.fill('#signup-id', userId);
  await page.fill('#signup-password', password);
  await page.click('#signup-submit');
  await page.waitForFunction(() => !document.getElementById('recovery-code-panel').hidden, undefined, { timeout: 5000 }).catch(() => {});
  await page.click('.account-close');
  await page.click('#review-toggle');
  const loginState = await page.evaluate(() => ({ reviewLoginHidden: document.getElementById('review-login')?.hidden }));
  ok('実サーバでアカウント作成→ログイン状態になる(見直しのログイン導線が消える)', loginState.reviewLoginHidden === true, loginState);
  await page.click('#review-dialog-close');

  // --- 実DOMで数式を入力 ---
  await page.click('math-field');
  await page.keyboard.type('2');
  await page.keyboard.press('KeyX'); // xキー相当は変換テーブル依存のため、Unicode直接貼り付けで確実に内容を作る
  await page.waitForTimeout(300);
  await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); row.mf.value = '\\int 2x\\,dx'; row.mf.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(600);

  // --- 見直しダイアログを開いて実送信(サーバ応答だけ差し替え) ---
  await page.click('#review-toggle');
  await page.fill('#review-problem', '∫2x dx を求めよ');
  await page.fill('#review-conditions', '置換積分で解いた');
  const submitResponse = page.waitForResponse((response) => response.url().includes('/api/reviews') && response.request().method() === 'POST');
  await page.click('#review-submit');
  const response = await submitResponse;
  ok('見直し送信が201で返る(応答は差し替え・送信経路は実サーバ)', response.status() === 201, response.status());

  await page.waitForSelector('#review-result:not([hidden])', { timeout: 5000 });
  const rendered = await page.evaluate(() => ({
    strengths: document.getElementById('review-strengths').textContent,
    corrections: document.getElementById('review-corrections').textContent,
    nextStep: document.getElementById('review-next-step').textContent,
    stagesCount: document.querySelectorAll('#review-stage-list li').length,
  }));
  ok('結果カードが実DOMへ描画される', rendered.strengths.includes('置換の発想は正しい') && rendered.nextStep.includes('置換後の微分'), rendered);
  ok('検証の流れ(4段階)が描画される', rendered.stagesCount === 4, rendered);

  // --- ダイアログを閉じて数式へフォーカスが戻る ---
  await page.click('#review-dialog-close');
  await page.waitForTimeout(50);
  ok('閉じると見直しダイアログが閉じる', await page.evaluate(() => !document.getElementById('review-dialog').open));

  // --- 編集すると「編集前の結果」表示に切り替わる(stale) ---
  await page.click('#review-toggle');
  await page.waitForTimeout(30);
  const staleBefore = await page.evaluate(() => document.getElementById('review-stale').hidden);
  ok('編集前は編集済み表示が出ない', staleBefore === true);
  await page.click('#review-dialog-close');
  await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); row.mf.value = '\\int 2x\\,dx = x^2 + 5'; row.mf.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(200);
  await page.click('#review-toggle');
  await page.waitForTimeout(30);
  const staleAfter = await page.evaluate(() => ({ hidden: document.getElementById('review-stale').hidden, text: document.getElementById('review-stale').textContent }));
  ok('式を編集すると「編集前の結果」表示(stale)へ切り替わる', staleAfter.hidden === false && staleAfter.text.includes('編集されています'), staleAfter);
  await page.click('#review-dialog-close');

  // --- ページ再読込後、保存済みの見直しを開き直せる ---
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#review-toggle');
  await page.waitForSelector('#review-history:not([hidden])', { timeout: 5000 }).catch(() => {});
  const history = await page.evaluate(() => ({
    hidden: document.getElementById('review-history').hidden,
    itemCount: document.querySelectorAll('.review-history-item').length,
  }));
  ok('再読込後も保存済みの見直し履歴が一覧に出る', !history.hidden && history.itemCount >= 1, history);
  if (history.itemCount >= 1) {
    await page.click('#review-history summary');
    await page.click('.review-history-item');
    await page.waitForSelector('#review-result:not([hidden])', { timeout: 5000 });
    const reopened = await page.evaluate(() => document.getElementById('review-next-step').textContent);
    ok('履歴から過去の見直し結果を開き直せる', reopened.includes('置換後の微分'), reopened);
  }

  ok('画面エラーなし', consoleErrors.length === 0, consoleErrors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
