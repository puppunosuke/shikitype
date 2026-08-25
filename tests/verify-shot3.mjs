import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 360, height: 1600 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'tests/out-verify-main-360.png' });
await page.click('#sidebar-toggle');
await page.locator('#sidebar').screenshot({ path: 'tests/out-verify-sidebar-360.png' });
await browser.close();
