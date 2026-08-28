// Iroha (design review) ad-hoc script — inspects the AI review feature UI without a live backend.
// Simulates login/result state directly via DOM (documented in the report as "differed").
// Real (not simulated): dialog open/close, Escape key routing, focus, layout at multiple widths/themes.
import { chromium } from '../spike/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const base = 'http://127.0.0.1:8893/';
const outDir = 'F:/12_Claude/Claude/neo-math-solution/tests/iroha-shots-ai-review';
fs.mkdirSync(outDir, { recursive: true });

const fakeCard = {
  strengths: ['置換 u = 2x の設定は正しいです。', 'dx を du に置き換える手順も合っています。'],
  corrections: [
    { blockId: 'row-2', text: '2行目、積分後に +C を書き忘れています。' },
  ],
  nextStep: '置換前の変数に戻す前に、もう一度 du/dx を確認してみましょう。',
};
const fakeStages = [
  { stage: 'independent_solver' },
  { stage: 'solution_auditor' },
  { stage: 'falsifier', skipped: true, reason: '独立解答と照合の信頼度が十分だったため省略' },
  { stage: 'tutor' },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(base, { waitUntil: 'networkidle' });

  // Enter a formula so the review button has something to send.
  await page.click('math-field').catch(() => {});
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    row.mf.value = '\\int 2x\\,dx';
    row.mf.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  // --- 1) open dialog: not-logged-in state (real behavior, no backend running) ---
  await page.click('#review-toggle');
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${outDir}/1-not-logged-in-1280.png` });

  const loginState = await page.evaluate(() => ({
    loginBtnHidden: document.getElementById('review-login').hidden,
    statusText: document.getElementById('review-status').textContent,
    submitDisabled: document.getElementById('review-submit').disabled,
  }));
  console.log('loginState', loginState);

  // --- 2) simulate "submitting" state (setReviewStatus + disabled submit are simple DOM ops we can mirror) ---
  await page.evaluate(() => {
    document.getElementById('review-status').textContent = 'ノートを保存してから見直しています…';
    document.getElementById('review-submit').disabled = true;
  });
  await page.screenshot({ path: `${outDir}/2-submitting-1280.png` });
  await page.evaluate(() => { document.getElementById('review-submit').disabled = false; });

  // --- 3) simulate rendered result (mirrors renderReviewResult's DOM writes) ---
  await page.evaluate(({ card, stages }) => {
    document.getElementById('review-setup').hidden = true;
    const section = document.getElementById('review-result');
    section.hidden = false;
    const strengths = document.getElementById('review-strengths');
    strengths.replaceChildren();
    for (const text of card.strengths) { const li = document.createElement('li'); li.textContent = text; strengths.append(li); }
    const corrections = document.getElementById('review-corrections');
    corrections.replaceChildren();
    for (const c of card.corrections) { const b = document.createElement('button'); b.type = 'button'; b.className = 'review-correction'; b.textContent = c.text; corrections.append(b); }
    document.getElementById('review-next-step').textContent = card.nextStep;
    const trace = document.getElementById('review-stage-list');
    trace.replaceChildren();
    const labels = { independent_solver: '独立した解法を作成', solution_auditor: '答案と照合', falsifier: '診断を再検証', tutor: '最小のヒントに整理' };
    for (const s of stages) { const li = document.createElement('li'); li.textContent = s.skipped ? `${labels[s.stage]}（${s.reason}）` : labels[s.stage]; trace.append(li); }
    document.getElementById('review-trace').hidden = false;
  }, { card: fakeCard, stages: fakeStages });
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${outDir}/3-result-1280.png` });

  // --- 4) stale switch ---
  await page.evaluate(() => {
    const stale = document.getElementById('review-stale');
    stale.textContent = 'この結果の後にノートが編集されています。';
    stale.hidden = false;
  });
  await page.screenshot({ path: `${outDir}/4-stale-1280.png` });

  // --- 5) history populated ---
  await page.evaluate(() => {
    const details = document.getElementById('review-history');
    details.hidden = false;
    details.open = true;
    const list = document.getElementById('review-history-list');
    list.replaceChildren();
    for (const label of ['8/28 21:40 · 途中のヒント', '8/28 20:10 · 解き終わりのレビュー']) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'review-history-item'; b.textContent = label;
      list.append(b);
    }
  });
  await page.screenshot({ path: `${outDir}/5-history-1280.png` });

  // --- 6) Escape closes dialog (REAL: exercises actual global keydown handler) ---
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const closedByEscape = await page.evaluate(() => !document.getElementById('review-dialog').open);
  console.log('closedByEscape', closedByEscape);

  // --- 7) narrow width (360) ---
  await page.setViewportSize({ width: 360, height: 780 });
  await page.click('#review-toggle');
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${outDir}/6-not-logged-in-360.png` });
  await page.evaluate(({ card, stages }) => {
    document.getElementById('review-setup').hidden = true;
    document.getElementById('review-result').hidden = false;
    const strengths = document.getElementById('review-strengths'); strengths.replaceChildren();
    for (const text of card.strengths) { const li = document.createElement('li'); li.textContent = text; strengths.append(li); }
    const corrections = document.getElementById('review-corrections'); corrections.replaceChildren();
    for (const c of card.corrections) { const b = document.createElement('button'); b.type = 'button'; b.className = 'review-correction'; b.textContent = c.text; corrections.append(b); }
    document.getElementById('review-next-step').textContent = card.nextStep;
    document.getElementById('review-stale').hidden = false;
    document.getElementById('review-stale').textContent = 'この結果の後にノートが編集されています。';
    const details = document.getElementById('review-history'); details.hidden = false; details.open = true;
    const list = document.getElementById('review-history-list'); list.replaceChildren();
    for (const label of ['8/28 21:40 · 途中のヒント']) { const b = document.createElement('button'); b.type = 'button'; b.className = 'review-history-item'; b.textContent = label; list.append(b); }
  }, { card: fakeCard, stages: fakeStages });
  await page.screenshot({ path: `${outDir}/7-result-360.png` });

  // header button placement check at 360
  const headerBox = await page.evaluate(() => {
    const btn = document.getElementById('review-toggle');
    const r = btn.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, width: innerWidth };
  });
  console.log('review-toggle box at 360:', headerBox);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => document.getElementById('review-dialog')?.close());

  // --- 8) all 5 themes at 1280, result state ---
  const themeIds = ['06', '08', '09', '13', '18'];
  console.log('themeIds', themeIds);
  for (const t of themeIds) {
    await page.evaluate((id) => window.__neoApp.applyTheme(id), t);
    await page.click('#review-toggle');
    await page.waitForTimeout(80);
    await page.evaluate(({ card, stages }) => {
      document.getElementById('review-setup').hidden = true;
      document.getElementById('review-result').hidden = false;
      const strengths = document.getElementById('review-strengths'); strengths.replaceChildren();
      for (const text of card.strengths) { const li = document.createElement('li'); li.textContent = text; strengths.append(li); }
      const corrections = document.getElementById('review-corrections'); corrections.replaceChildren();
      for (const c of card.corrections) { const b = document.createElement('button'); b.type = 'button'; b.className = 'review-correction'; b.textContent = c.text; corrections.append(b); }
      document.getElementById('review-next-step').textContent = card.nextStep;
    }, { card: fakeCard, stages: fakeStages });
    await page.screenshot({ path: `${outDir}/theme-${t}-1280.png` });
    await page.evaluate(() => document.getElementById('review-dialog')?.close());
  }

  console.log('consoleErrors', consoleErrors);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
