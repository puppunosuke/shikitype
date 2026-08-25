import { chromium } from 'playwright';
import fs from 'fs';

const OUT = 'F:/12_Claude/Claude/neo-math-solution/spike/iroha-shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.goto('http://localhost:8893/app.html');
await page.waitForTimeout(300);

function trackFocus() {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      id: el?.id || null, cls: el?.className || null, tag: el?.tagName,
      text: (el?.textContent || '').trim().slice(0, 40),
      ariaLabel: el?.getAttribute?.('aria-label') || null,
    };
  });
}

await page.evaluate(() => document.getElementById('sidebar-toggle').focus());
await page.keyboard.press('Enter');
await page.waitForTimeout(200);

// Tab 15 times to reach the first selectable key-cap (Q key, per trace)
for (let i = 0; i < 15; i++) await page.keyboard.press('Tab');
let f = await trackFocus();
console.log('focused key before select:', JSON.stringify(f));

// select this key with Enter (keyboard activation => event.detail === 0)
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
f = await trackFocus();
console.log('focus after Enter on key-cap (should be assign-grid first button):', JSON.stringify(f));

await page.screenshot({ path: `${OUT}/02-assign-open-1024.png` });

// Verify assign-section is visible and check visual affordance (bounding box, siblings)
const assignInfo = await page.evaluate(() => {
  const sec = document.getElementById('assign-section');
  const rect = sec.getBoundingClientRect();
  const title = document.getElementById('assign-title').textContent;
  return { hidden: sec.hidden, rect, title };
});
console.log('assign-section info:', JSON.stringify(assignInfo));

// Now select an assignment via keyboard: Enter on the focused assign-btn
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
f = await trackFocus();
console.log('focus after assigning (Enter on assign-btn):', JSON.stringify(f));

await page.screenshot({ path: `${OUT}/03-after-assign-1024.png` });

// Now tab back through to reach assign-reset / continue, then check "back to config-keys" flow:
// Try shift+tab back to key-caps and confirm focus is retained visibly (outline)
await page.keyboard.press('Tab'); // to assign-reset probably
f = await trackFocus();
console.log('focus after 1 more tab (post-assign):', JSON.stringify(f));

await browser.close();
