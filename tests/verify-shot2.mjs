import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 1400 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#sidebar-toggle');
await page.locator('#sidebar').screenshot({ path: 'tests/out-verify-sidebar-full.png' });
await browser.close();
