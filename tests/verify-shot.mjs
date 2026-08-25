import { chromium } from '../spike/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8893/app.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });

const widths = [1024, 736, 360];
const themes = ['06', '08', '09', '13', '18'];
const overflowIssues = [];

for (const width of widths) {
  await page.setViewportSize({ width, height: 900 });
  for (const theme of themes) {
    await page.evaluate((t) => window.__neoApp.applyTheme(t), theme);
    await page.waitForTimeout(60);
    // 1) メイン画面（サイドバー閉）
    await page.screenshot({ path: `tests/out-verify-main-${width}-${theme}.png` });
    const mainOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (mainOverflow) overflowIssues.push({ width, theme, where: 'main' });

    // 2) 設定ドロワー開
    await page.click('#sidebar-toggle');
    await page.waitForTimeout(60);
    await page.screenshot({ path: `tests/out-verify-sidebar-${width}-${theme}.png`, fullPage: false });
    const sidebarOverflow = await page.evaluate(() => {
      const sb = document.getElementById('sidebar');
      return sb.scrollWidth > sb.clientWidth + 1;
    });
    if (sidebarOverflow) overflowIssues.push({ width, theme, where: 'sidebar' });
    await page.click('#sidebar-close');
  }
}
console.log('overflowIssues:', JSON.stringify(overflowIssues, null, 2));
await browser.close();
