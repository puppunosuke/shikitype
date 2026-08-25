import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleIssues = [];
page.on('console', (m) => { if (m.type() === 'error') consoleIssues.push(m.text()); });
page.on('pageerror', (e) => consoleIssues.push('pageerror: ' + e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });

// 全単元を切替えてパレットの新規記号を順に挿入し、MathLiveのlatex()往復とエラーの有無を見る
const results = await page.evaluate(async () => {
  const app = window.__neoApp;
  const row = app.getActiveRow();
  const out = [];
  const labels = ['x̄', 's²', 'nCr', 'nPr', '(n k)', 'a⃗', '|a⃗|', 'a⃗·b⃗', 'z̄', 'arg', '|z|', 'a∣b', '(mod n)', 'a_n', 'a_{n+1}', 'Δa_n', 'log_a b', 'ln'];
  for (const label of labels) {
    row.mf.value = '';
    const btns = [...document.querySelectorAll('#palette-grid .palette-btn')];
    // パレットは単元でソートされるため、都度全部見て探す
    document.getElementById('sidebar')?.classList; // noop
    const btn = btns.find((b) => b.textContent === label);
    if (!btn) { out.push({ label, found: false }); continue; }
    btn.click();
    out.push({ label, found: true, latex: row.mf.value, mathml: row.mf.getValue('math-ml')?.length > 0 });
  }
  return out;
});
console.log(JSON.stringify(results, null, 2));
console.log('consoleIssues:', JSON.stringify(consoleIssues));
await browser.close();
