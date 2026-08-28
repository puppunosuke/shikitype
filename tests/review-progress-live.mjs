// AI見直しの「待ち時間の体験」修正の実画面検証（かぐや、2026-08-28）。
// 実サーバ(wrangler dev --config wrangler.test.jsonc, :8788)+実D1に対し、実ブラウザで
// サインアップ→ノート保存→見直し送信まで行う。本物のOpenAIキーが無いため、POST /api/reviews
// の応答本体だけPlaywrightのroute interceptで遅延・失敗させて差し替える（他のsmokeと同じ手法）。
// 差し替えているのは「OpenAIの応答が返ってくるまでの遅さ・失敗」の再現だけで、進行表示・
// 経過時間・ダイアログの開閉・review-toggleの状態遷移はすべて実DOM・実タイマーで検証する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const base = 'http://127.0.0.1:8788/';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}`, JSON.stringify(detail)); } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeCard = { strengths: ['置換の発想は正しいです。'], corrections: [{ blockId: null, text: '2行目の係数を見直してください。' }], nextStep: '置換後の微分を一行だけ確かめよう。', confidence: 0.9 };
const fakeStages = [
  { stage: 'independent_solver', inputScope: 'problem_and_conditions' },
  { stage: 'solution_auditor', inputScope: 'reference_solution_and_student_blocks' },
  { stage: 'falsifier', inputScope: 'reference_and_audit_summary' },
  { stage: 'tutor', inputScope: 'safe_audit_handoff_only' },
];

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

  const userId = `e2e${Date.now().toString(36)}`;
  await page.click('#account-toggle');
  await page.click('#account-tab-signup');
  await page.fill('#signup-id', userId);
  await page.fill('#signup-password', 'e2e-review-progress-123');
  await page.click('#signup-submit');
  await page.waitForFunction(() => !document.getElementById('recovery-code-panel').hidden, undefined, { timeout: 5000 }).catch(() => {});
  await page.click('.account-close');

  await page.click('math-field');
  await page.waitForTimeout(200);
  await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); row.mf.value = '\\int 2x\\,dx'; row.mf.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(400);

  // ============ ケース1: 遅い成功応答・待機中にダイアログを閉じて他操作→戻って結果を見る ============
  let released1;
  const gate1 = new Promise((resolve) => { released1 = resolve; });
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate1;
    const body = JSON.parse(route.request().postData() || '{}');
    const result = { runId: 'run-slow-0001', noteId: body.noteId, noteUpdatedAt: body.noteUpdatedAt, reviewKind: body.reviewKind, mode: body.mode, card: fakeCard, stages: fakeStages, createdAt: new Date().toISOString() };
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.route('**/api/notes/*/reviews', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reviews: [] }) }) : route.continue()));

  await page.click('#review-toggle');
  await page.fill('#review-problem', '∫2x dx を求めよ');
  await page.click('#review-submit');
  await page.waitForTimeout(150);

  const justSubmitted = await page.evaluate(() => ({
    progressVisible: !document.getElementById('review-progress').hidden,
    setupHidden: document.getElementById('review-setup').hidden,
    submitDisabled: document.getElementById('review-submit').disabled,
  }));
  ok('送信直後: 進行パネルが見え、入力面は隠れ、送信ボタンは無効化される', justSubmitted.progressVisible && justSubmitted.setupHidden && justSubmitted.submitDisabled, justSubmitted);

  await sleep(2200);
  const elapsedEarly = await page.evaluate(() => document.getElementById('review-progress-status').textContent);
  const earlySeconds = Number((elapsedEarly.match(/経過(\d+)秒/) || [])[1]);
  ok('約2.2秒後: 経過秒数が実時間で1〜4秒の範囲に増えている(固まって見えない)', Number.isInteger(earlySeconds) && earlySeconds >= 1 && earlySeconds <= 4, elapsedEarly);

  await sleep(3000);
  const elapsedLater = await page.evaluate(() => document.getElementById('review-progress-status').textContent);
  const laterSeconds = Number((elapsedLater.match(/経過(\d+)秒/) || [])[1]);
  ok('さらに3秒後: 経過秒数が増え続けている', laterSeconds > earlySeconds, { earlySeconds, laterSeconds });

  const stageList = await page.evaluate(() => [...document.querySelectorAll('#review-progress-stages li')].map((li) => li.textContent));
  ok('段階リストに4段階すべてが日本語ラベルで並ぶ(サーバ未到達分はpendingとして安全に表示)', stageList.length === 4 && stageList.some((t) => t.includes('独立した解法を作成')) && stageList.some((t) => t.includes('答案と照合')) && stageList.some((t) => t.includes('診断を再検証')) && stageList.some((t) => t.includes('最小のヒントに整理')), stageList);

  // 待機中にダイアログを閉じて他の操作をする
  await page.click('#review-progress-close');
  await page.waitForTimeout(50);
  const closedMidflight = await page.evaluate(() => !document.getElementById('review-dialog').open);
  ok('待機中に「閉じて他の操作をする」で実際にダイアログが閉じる', closedMidflight);

  const backgroundUsable = await page.evaluate(() => {
    const notesToggle = document.getElementById('notes-toggle');
    notesToggle.click();
    const opened = notesToggle.getAttribute('aria-expanded') === 'true';
    notesToggle.click();
    return opened;
  });
  ok('ダイアログを閉じている間、背景の操作(過去のノート開閉)が効く(閉じ込められていない)', backgroundUsable);

  // 裏で見直しは継続している。応答を解放する。
  released1();
  await page.waitForFunction(() => document.getElementById('review-toggle').textContent.includes('結果あり'), undefined, { timeout: 5000 });
  const toggleAfterBgFinish = await page.evaluate(() => ({ text: document.getElementById('review-toggle').textContent, ariaLabel: document.getElementById('review-toggle').getAttribute('aria-label'), dialogOpen: document.getElementById('review-dialog').open }));
  ok('閉じている間に完了すると、見直すボタンが「結果あり」表示に切り替わる(勝手に再オープンはしない)', toggleAfterBgFinish.text.includes('結果あり') && !toggleAfterBgFinish.dialogOpen, toggleAfterBgFinish);

  await page.click('#review-toggle');
  await page.waitForTimeout(80);
  const reopened = await page.evaluate(() => ({
    resultVisible: !document.getElementById('review-result').hidden,
    setupHidden: document.getElementById('review-setup').hidden,
    progressHidden: document.getElementById('review-progress').hidden,
    nextStep: document.getElementById('review-next-step').textContent,
    toggleText: document.getElementById('review-toggle').textContent,
  }));
  ok('再度開くと結果画面に直接入り(setupへ戻されない)、内容も正しい', reopened.resultVisible && reopened.setupHidden && reopened.progressHidden && reopened.nextStep.includes('置換後の微分'), reopened);
  ok('結果を見たら見直すボタンの表示は通常に戻る', reopened.toggleText.includes('見直す') && !reopened.toggleText.includes('結果あり'), reopened.toggleText);

  await page.click('#review-dialog-close');
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // ============ ケース2: 開いたまま待つ場合は自動的に結果へ切り替わる ============
  let released2;
  const gate2 = new Promise((resolve) => { released2 = resolve; });
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate2;
    const body = JSON.parse(route.request().postData() || '{}');
    const result = { runId: 'run-slow-0002', noteId: body.noteId, noteUpdatedAt: body.noteUpdatedAt, reviewKind: body.reviewKind, mode: body.mode, card: fakeCard, stages: fakeStages, createdAt: new Date().toISOString() };
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.route('**/api/notes/*/reviews', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reviews: [] }) }) : route.continue()));

  await page.click('#review-toggle');
  await page.waitForTimeout(80);
  await page.click('#review-submit');
  await page.waitForTimeout(150);
  const escapeStillWorks = await page.evaluate(() => document.getElementById('review-dialog').open);
  ok('待機中もダイアログはEscapeで閉じられる状態のまま(モーダルとしてフォーカスは保持)', escapeStillWorks);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  const escapedDuringWait = await page.evaluate(() => !document.getElementById('review-dialog').open);
  ok('待機中にEscapeを押すと閉じる(壊れていない)', escapedDuringWait);
  await page.click('#review-toggle');
  await page.waitForTimeout(80);
  const reopenedWhileRunning = await page.evaluate(() => !document.getElementById('review-progress').hidden);
  ok('実行中に開き直すと進行パネルに戻る(setupへ巻き戻らない)', reopenedWhileRunning);

  released2();
  await page.waitForSelector('#review-result:not([hidden])', { timeout: 5000 });
  const autoSwitched = await page.evaluate(() => ({ resultVisible: !document.getElementById('review-result').hidden, toggleText: document.getElementById('review-toggle').textContent }));
  ok('開いたまま待つと完了時に自動で結果画面へ切り替わる', autoSwitched.resultVisible && autoSwitched.toggleText.includes('見直す') && !autoSwitched.toggleText.includes('結果あり'), autoSwitched);
  await page.click('#review-dialog-close');
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // ============ ケース3: 失敗応答(待機中に閉じていた場合) ============
  let released3;
  const gate3 = new Promise((resolve) => { released3 = resolve; });
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate3;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'review_not_configured' }) });
  });
  await page.route('**/api/notes/*/reviews', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reviews: [] }) }) : route.continue()));

  await page.click('#review-toggle');
  await page.waitForTimeout(80);
  await page.click('#review-submit');
  await page.waitForTimeout(150);
  await page.click('#review-progress-close');
  released3();
  await page.waitForTimeout(300);
  const toggleAfterBgFailure = await page.evaluate(() => document.getElementById('review-toggle').textContent);
  ok('閉じている間に失敗しても「結果あり」を偽って出さない(通常表示のまま)', toggleAfterBgFailure.includes('見直す') && !toggleAfterBgFailure.includes('結果あり'), toggleAfterBgFailure);
  await page.click('#review-toggle');
  await page.waitForTimeout(80);
  const errorShownOnReopen = await page.evaluate(() => ({ setupVisible: !document.getElementById('review-setup').hidden, statusText: document.getElementById('review-status').textContent, isError: document.getElementById('review-status').dataset.error === 'true' }));
  ok('再度開くと、閉じている間に起きた失敗の理由がsetup画面に出る', errorShownOnReopen.setupVisible && errorShownOnReopen.isError && errorShownOnReopen.statusText.includes('設定されていません'), errorShownOnReopen);
  await page.click('#review-dialog-close');
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // ケース3は意図的に503を発生させるテストなので、そのリソース読み込み失敗ログ自体は
  // ブラウザの通常動作(JS例外ではない)。それ以外のconsoleエラーが無いことを確認する。
  const unexpectedConsoleErrors = consoleErrors.filter((entry) => !entry.includes('503'));
  ok('画面エラーなし(意図的な503応答ログを除く)', unexpectedConsoleErrors.length === 0, consoleErrors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
