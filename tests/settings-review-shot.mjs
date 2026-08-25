import { chromium } from '../spike/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const outDir = 'F:/12_Claude/Claude/.tmp/neo-math-settings-review';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.removeItem('neo-math.theme.v1');
  localStorage.removeItem('neo-math.theme-rail-collapsed.v1');
});
await page.reload({ waitUntil: 'networkidle' });

await page.click('#sidebar-toggle');
await page.click('[data-settings-category="appearance"]');
await page.click('.compact-theme[data-theme="08"]');
await page.click('[data-settings-category="keys"]');
await page.locator('#config-keys').scrollIntoViewIfNeeded();
await page.waitForTimeout(250);
await page.screenshot({ path: `${outDir}/settings-controls.png`, fullPage: false });

await page.click('#sidebar-theme-choice .theme-choice[data-theme="18"]');
await page.click('#sidebar-close');
await page.click('#theme-rail-collapse');
await page.waitForTimeout(250);
await page.screenshot({ path: `${outDir}/desktop-collapsed.png`, fullPage: false });

await page.setViewportSize({ width: 736, height: 900 });
await page.waitForTimeout(250);
await page.screenshot({ path: `${outDir}/narrow-collapsed.png`, fullPage: false });
await page.click('#theme-rail-collapse');
await page.waitForTimeout(250);
await page.screenshot({ path: `${outDir}/narrow-expanded.png`, fullPage: false });

await page.setViewportSize({ width: 360, height: 800 });
await page.waitForTimeout(220);
await page.screenshot({ path: `${outDir}/phone-expanded.png`, fullPage: false });

await browser.close();
