// 360pxの設定ドロワーでも、物理3段の全キーが横スクロール無しで選べることを確認する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
const THEMES = ['06', '08', '09', '13', '18'];
let failures = 0;

function ok(label, value, detail = value) {
  if (value) console.log(`  OK  ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`);
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.click('#sidebar-toggle');

for (const theme of THEMES) {
  await page.click('[data-settings-category="appearance"]');
  await page.click(`#sidebar-theme-choice .theme-choice[data-theme="${theme}"]`);
  await page.click('[data-settings-category="keys"]');
  const geometry = await page.evaluate(() => {
    const container = document.getElementById('config-keys');
    const containerRect = container.getBoundingClientRect();
    const rows = [...container.querySelectorAll('.key-row')];
    const caps = [...container.querySelectorAll('.key-cap')];
    return {
      clientWidth: container.clientWidth,
      scrollWidth: container.scrollWidth,
      rowWidths: rows.map((row) => ({ clientWidth: row.clientWidth, scrollWidth: row.scrollWidth })),
      capCount: caps.length,
      allCapsVisible: caps.every((cap) => {
        const rect = cap.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.left >= containerRect.left - 1
          && rect.right <= containerRect.right + 1;
      }),
    };
  });
  ok(`${theme}: 設定キーに横スクロールがない`, geometry.scrollWidth === geometry.clientWidth, geometry);
  ok(`${theme}: 3段ともドロワー幅内`, geometry.rowWidths.every((row) => row.scrollWidth === row.clientWidth), geometry);
  ok(`${theme}: 30キーすべて可視`, geometry.capCount === 30 && geometry.allCapsVisible, geometry);

  // 右端のSlashまで実際に押せることを確認する（見えているだけでは足りない）。
  await page.click('#config-keys .key-cap[data-code="Slash"]');
  const selected = await page.evaluate(() => ({
    selected: document.querySelector('#config-keys .key-cap.selected')?.dataset.code,
    assignmentOpen: !document.getElementById('assign-section').hidden,
  }));
  ok(`${theme}: 右端キーを選択できる`, selected.selected === 'Slash' && selected.assignmentOpen, selected);
}

ok('画面エラーなし', pageErrors.length === 0, pageErrors);
await browser.close();
console.log(`\n=== RESULT: ${failures === 0 ? 'passed' : 'failed'} ===`);
process.exit(failures ? 1 : 0);
