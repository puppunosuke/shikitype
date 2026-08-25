// パレットから記号を選んだ直後も、次の物理キーが数式欄へ入ることを実操作で確認する。
// `(mod n)` の出力そのものに加え、選択後の復帰フォーカスを守る回帰テスト。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let failures = 0;

function assertEqual(label, actual, expected) {
  if (actual === expected) {
    console.log(`  OK  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

// 数式常駐は英字層を基底にするため、a / b / c を実際の物理キーで続けて入力できる。
await page.click('#sidebar-toggle');
await page.click('[data-settings-category="input"]');
await page.click('.method-choice[data-input-method="math"]');
await page.click('#sidebar-close');
await page.keyboard.press('KeyA');

// 合同記号をパレットから選んだ後、物理Bが落ちないこと。
await page.keyboard.press('Escape');
await page.getByRole('button', { name: '≡', exact: true }).click();
await page.keyboard.press('KeyB');
assertEqual(
  'パレット選択後も次の物理キーを入力できる',
  await page.evaluate(() => window.__neoApp.getActiveRow().mf.value),
  String.raw`a\equiv b`,
);

// 整数の性質で使う `(mod n)` も、同じ復帰経路で正しいLaTeXを残し、その後のキーを受け取る。
await page.keyboard.press('Escape');
await page.getByRole('button', { name: '(mod n)', exact: true }).click();
assertEqual(
  '(mod n) は \\pmod{n} として挿入される',
  await page.evaluate(() => window.__neoApp.getActiveRow().mf.value),
  String.raw`a\equiv b\pmod{n}`,
);
await page.keyboard.press('KeyC');
assertEqual(
  '(mod n) 選択後も次の物理キーを入力できる',
  await page.evaluate(() => window.__neoApp.getActiveRow().mf.value),
  String.raw`a\equiv b\pmod{n}c`,
);
assertEqual('画面エラーなし', JSON.stringify(pageErrors), '[]');

await browser.close();
console.log(`\n=== RESULT: ${failures === 0 ? 'passed' : 'failed'} ===`);
process.exit(failures ? 1 : 0);
