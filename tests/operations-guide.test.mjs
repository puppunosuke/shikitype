// 段階4-6: 設定＞キー割当に追加した「操作」一覧の検証。
// 画面下のキーガイドは記号の割当を示すだけで足りている（拓男の指摘済み）ため、
// ここでは Alt+ドラッグ複製・Shift+ドラッグ矩形選択・Backspace再変換など
// 画面上に手がかりの無い操作を一覧できること、Tabの説明が現在の設定
// （入力方法・層ごとの切替方法）を実際に反映することを確認する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

let passed = 0; const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); } }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
await page.click('#sidebar-toggle');
await page.click('.settings-nav-item[data-settings-category="keys"]');
await page.waitForSelector('#operations-guide-list dt');

const entries = await page.evaluate(() => {
  const dts = [...document.querySelectorAll('#operations-guide-list dt')].map((d) => d.textContent);
  const dds = [...document.querySelectorAll('#operations-guide-list dd')].map((d) => d.textContent);
  return dts.map((k, i) => [k, dds[i]]);
});
const keys = entries.map(([k]) => k).join(' / ');
ok('Tab/Enter/矢印キー/Escapeを一覧する', ['Tab', 'Enter', '矢印キー', 'Escape'].every((k) => keys.includes(k)), keys);
ok('Backspaceの再変換に触れる（画面上に手がかりが無い操作）', entries.some(([k, d]) => k === 'Backspace' && d.includes('読みへ戻')), entries.find(([k]) => k === 'Backspace'));
ok('Ctrl+Z系・Ctrl+C/Vを一覧する', keys.includes('Ctrl+Z') && keys.includes('Ctrl+C'));
ok('Alt+ドラッグ複製を一覧する（彩葉指摘: 気づけない操作）', entries.some(([k, d]) => k.includes('Alt') && d.includes('複製')));
ok('Shift+ドラッグ矩形選択を一覧する（彩葉指摘: 気づけない操作）', entries.some(([k, d]) => k.includes('Shift') && d.includes('矩形選択')));
ok('文章ブロックの出入りを一覧する', entries.some(([k, d]) => k.includes('文') && d.includes('\\text{}')));
ok('記号の割当（キーガイドが既に示す情報）を重複させない', !entries.some(([, d]) => /[a-z]\/n|α\/n/.test(d)));

// Tabの説明は固定文字列ではなく、現在の設定（入力方法・層別切替方法）を反映する。
const legacyTab = entries[0][1];
await page.click('.settings-nav-item[data-settings-category="basic"]');
await page.click('.input-system-choice[data-input-system="conversion"]');
await page.click('.settings-nav-item[data-settings-category="input"]');
await page.click('#layer-method-conversion [data-choice-value="math"]');
await page.click('.settings-nav-item[data-settings-category="keys"]');
const conversionMathTab = await page.locator('#operations-guide-list dd').first().textContent();
ok('Tabの説明は現在の割当を反映して変わる（固定文字列の一覧ではない）', legacyTab !== conversionMathTab && conversionMathTab.includes('英字層'), { legacyTab, conversionMathTab });

await browser.close();
ok('ページエラーなし', pageErrors.length === 0, pageErrors);

console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
