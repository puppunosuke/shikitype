// ログイン導線は通常のローカル保存を妨げず、狭幅・全テーマで操作可能にする。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
const themes = ['06', '08', '09', '13', '18'];
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

const main = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 360, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#account-toggle');
  ok('ログインボタンでダイアログを開く', await page.locator('#account-dialog').evaluate((el) => el.open));
  for (const theme of themes) {
    await page.evaluate((id) => window.__neoApp.applyTheme(id), theme);
    const state = await page.evaluate(() => {
      const dialog = document.getElementById('account-dialog');
      const rect = dialog.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth };
    });
    ok(`${theme}: 狭幅でアカウント操作が横にはみ出さない`, state.left >= 0 && state.right <= state.viewport && state.scrollWidth <= state.clientWidth, state);
  }
  await page.click('[data-account-panel="signup"]');
  ok('アカウント作成へ切り替えられる', await page.locator('[data-panel="signup"]').evaluate((el) => !el.hidden));
  await page.click('[data-account-panel="recover"]');
  ok('回復へ切り替えられる', await page.locator('[data-panel="recover"]').evaluate((el) => !el.hidden));
  ok('通常のローカル画面で通信エラーを出さない', errors.length === 0, errors);
  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) process.exit(1);
};
main();
