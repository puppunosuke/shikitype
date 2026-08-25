import { chromium } from 'playwright';

const OUT = 'F:/12_Claude/Claude/neo-math-solution/spike/iroha-shots';
import fs from 'fs';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.goto('http://localhost:8893/app.html');
await page.waitForTimeout(500);

// --- 1. Pure keyboard flow: open drawer -> layer -> select key -> assign -> back ---
const log = [];
function trackFocus(label) {
  return page.evaluate((label) => {
    const el = document.activeElement;
    return { label, id: el?.id || null, cls: el?.className || null, tag: el?.tagName, text: (el?.textContent || '').trim().slice(0, 40) };
  }, label);
}

// Tab to the sidebar-toggle button. First find it and focus via keyboard nav from body.
await page.keyboard.press('Tab');
let f = await trackFocus('after 1 tab');
log.push(f);

// Instead of guessing tab order, directly focus the toggle then continue via real keys.
await page.evaluate(() => document.getElementById('sidebar-toggle').focus());
log.push(await trackFocus('focused sidebar-toggle programmatically (start point)'));

await page.keyboard.press('Enter');
await page.waitForTimeout(200);
log.push(await trackFocus('after Enter on sidebar-toggle (drawer should open)'));

await page.screenshot({ path: `${OUT}/01-drawer-open-1024.png`, fullPage: false });

// Tab through to reach layer-choice / config-keys via keyboard only
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Tab');
  const fi = await trackFocus(`tab ${i+1}`);
  log.push(fi);
  if (fi.id && fi.id.includes('sidebar-close')) break;
}

fs.writeFileSync(`${OUT}/focus-trace.json`, JSON.stringify(log, null, 2));
console.log('trace written');

await browser.close();
