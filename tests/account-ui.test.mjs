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
  ok('Googleの接続情報が無い静的表示では、Googleログイン導線を出さず既存ログインへ戻る', await page.locator('#google-login-panel').evaluate((el) => el.hidden));
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
  await page.locator('.account-close').click();

  // ログイン中はaccount-toggleの表示文字がログインIDへ変わる（バグ修正: 従来は
  // 「ログイン」固定のままだった）。長いIDでもサイドバー・ヘッダーからはみ出さない
  // ことを、実際のネットワークを使わずDOM直操作で全テーマ・両幅で確認する。
  const longUserId = 'very-long-example-login-id-12345';
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 760 });
    for (const theme of themes) {
      await page.evaluate(({ theme, id }) => {
        window.__neoApp.applyTheme(theme);
        document.getElementById('account-toggle').querySelector('span:last-child').textContent = id;
      }, { theme, id: longUserId });
      const state = await page.evaluate(() => {
        const shell = document.getElementById('app-shell');
        const toggle = document.getElementById('account-toggle');
        return {
          shellScrollWidth: shell.scrollWidth,
          shellClientWidth: shell.clientWidth,
          toggleScrollWidth: toggle.scrollWidth,
          toggleClientWidth: toggle.clientWidth,
        };
      });
      ok(`${width}px/${theme}: 長いログインIDでもアプリ全体が横スクロールしない`, state.shellScrollWidth <= state.shellClientWidth + 1, state);
      ok(`${width}px/${theme}: 長いログインIDはaccount-toggle内で省略され、ボタン自体は幅からはみ出さない`, state.toggleScrollWidth <= state.toggleClientWidth + 1, state);
    }
  }
  await page.evaluate(() => window.__neoApp.applyTheme('09'));

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) process.exit(1);
};
main();
