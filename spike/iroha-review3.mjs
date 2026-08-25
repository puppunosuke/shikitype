import { chromium } from 'playwright';
import fs from 'fs';

const OUT = 'F:/12_Claude/Claude/neo-math-solution/spike/iroha-shots';
fs.mkdirSync(OUT, { recursive: true });

const themes = ['06', '08', '09', '13', '18'];
const widths = [1024, 736, 360];

const browser = await chromium.launch();

for (const width of widths) {
  for (const theme of themes) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto('http://localhost:8893/app.html');
    await page.waitForTimeout(200);
    await page.evaluate((t) => {
      document.querySelector(`.theme-choice[data-theme="${t}"]`)?.click();
    }, theme);
    await page.waitForTimeout(100);
    await page.evaluate(() => document.getElementById('sidebar-toggle').focus());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    for (let i = 0; i < 15; i++) await page.keyboard.press('Tab');
    await page.keyboard.press('Enter'); // select key -> focus moves to first assign-btn
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/theme${theme}-w${width}-assignfocus.png` });
    await page.close();
  }
}

await browser.close();
console.log('done');
