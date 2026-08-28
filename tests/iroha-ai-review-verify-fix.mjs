import { chromium } from '../spike/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://127.0.0.1:8893/', { waitUntil: 'networkidle' });
await page.click('math-field').catch(() => {});
await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); row.mf.value = '\int 2x\,dx'; row.mf.dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForTimeout(200);
await page.click('#review-toggle');
await page.waitForTimeout(100);
await page.evaluate(() => {
  document.getElementById('review-setup').hidden = true;
  document.getElementById('review-result').hidden = false;
  document.getElementById('review-strengths').innerHTML = '<li>ok</li>';
  document.getElementById('review-corrections').textContent = 'fix here';
  document.getElementById('review-next-step').textContent = 'next';
  const details = document.getElementById('review-history'); details.hidden = false;
  document.getElementById('review-history-list').innerHTML = '<button class="review-history-item">past 1</button>';
});
await page.screenshot({ path: 'tests/iroha-shots-ai-review/8-fix-back-to-list-1280.png' });
await page.click('#review-back-to-list');
await page.waitForTimeout(100);
const state = await page.evaluate(() => ({
  setupHidden: document.getElementById('review-setup').hidden,
  resultHidden: document.getElementById('review-result').hidden,
  historyHidden: document.getElementById('review-history').hidden,
  historyItemText: document.querySelector('.review-history-item')?.textContent,
  focusedIsProblem: document.activeElement.id === 'review-problem',
}));
console.log('after clicking review-back-to-list:', state);
await page.screenshot({ path: 'tests/iroha-shots-ai-review/9-fix-back-to-list-after-click-1280.png' });
await page.setViewportSize({ width: 360, height: 780 });
await page.evaluate(() => {
  document.getElementById('review-setup').hidden = true;
  document.getElementById('review-result').hidden = false;
});
await page.screenshot({ path: 'tests/iroha-shots-ai-review/10-fix-360.png' });
await browser.close();
