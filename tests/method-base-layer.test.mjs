// 入力方式ごとの基底層（記号／英字の入れ替え）の検証。
// 既定は現行挙動（記号が基底、長押しは短押し=英字・長押し=記号）を維持しつつ、
// 方式ごとに独立して保存・切替できることを確認する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];

function ok(label, value, detail = value) {
  if (value) {
    passed++;
    console.log('  OK  ' + label);
  } else {
    failures.push({ label, detail });
    console.log('  FAIL ' + label + ': ' + JSON.stringify(detail));
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (err) => failures.push({ label: 'pageerror', detail: err.message }));
  const consoleIssues = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleIssues.push({ type: message.type(), text: message.text() });
    }
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.removeItem('neo-math.method-base-layer.v1');
    localStorage.removeItem('neo-math.input-method.v1');
  });
  await page.reload({ waitUntil: 'networkidle' });

  console.log('\n== 1. 既定値は現行の挙動を維持する ==');
  const defaults = await page.evaluate(() => window.__neoApp.getMethodBaseLayer());
  ok('既定は toggle=記号 / math=英字 / hybrid=記号 / hold=英字',
    defaults.toggle === 'symbol' && defaults.math === 'latin' && defaults.hybrid === 'symbol' && defaults.hold === 'latin',
    defaults);

  console.log('\n== 2. 設定UIから方式ごとに選べる ==');
  await page.click('#sidebar-toggle');
  await page.click('[data-settings-category="input"]');
  const rowCount = await page.locator('#method-base-list .method-base-row').count();
  ok('4方式ぶんの行がある', rowCount === 4, rowCount);

  console.log('\n== 3. 長押し方式を記号優先に切り替えると、短押し/長押しが入れ替わる ==');
  await page.click('.method-choice[data-input-method="hold"]');
  await page.click('#method-base-hold button:has-text("記号")');
  const swapped = await page.evaluate(() => ({
    saved: JSON.parse(localStorage.getItem('neo-math.method-base-layer.v1')),
    base: window.__neoApp.getBaseLayer(),
  }));
  ok('保存値がhold=記号になる', swapped.saved.hold === 'symbol', swapped);
  ok('現在の基底層も記号に変わる', swapped.base === 'symbol', swapped);

  // Aキー（α/aの物理キー）で確認: 記号が基底なら短押しでaの記号(√)が出て、長押しでaの文字(a)が出るはず
  const aKeyAfterSwap = await page.evaluate(() => {
    const cap = document.querySelector('#key-guide-board .key-cap[data-code="KeyA"]');
    return {
      shortLabel: cap.querySelector('.key-symbol').textContent,
      longLabel: cap.querySelector('.key-hold-symbol')?.textContent ?? null,
    };
  });
  ok('入れ替え後: 短押し=√（記号）、長押し=a（英字）', aKeyAfterSwap.shortLabel === '√' && aKeyAfterSwap.longLabel === 'a', aKeyAfterSwap);

  console.log('\n== 4. 他方式の設定は独立して残る ==');
  const othersUnaffected = await page.evaluate(() => window.__neoApp.getMethodBaseLayer());
  ok('toggle/math/hybridは既定のまま', othersUnaffected.toggle === 'symbol' && othersUnaffected.math === 'latin' && othersUnaffected.hybrid === 'symbol', othersUnaffected);

  console.log('\n== 5. 元に戻すと短押し=英字・長押し=記号に戻る ==');
  await page.click('#method-base-hold button:has-text("英字")');
  const reverted = await page.evaluate(() => {
    const cap = document.querySelector('#key-guide-board .key-cap[data-code="KeyA"]');
    return {
      base: window.__neoApp.getBaseLayer(),
      shortLabel: cap.querySelector('.key-symbol').textContent,
      longLabel: cap.querySelector('.key-hold-symbol')?.textContent ?? null,
    };
  });
  ok('戻すと短押し=a、長押し=√', reverted.base === 'latin' && reverted.shortLabel === 'a' && reverted.longLabel === '√', reverted);

  console.log('\n== 6. 長押し方式の実際の打鍵挙動も入れ替わる ==');
  await page.click('#method-base-hold button:has-text("記号")');
  await page.click('#sidebar-close');
  const row0 = await page.evaluate(() => window.__neoApp.getActiveRow().mf.value);
  ok('式は空から始める', row0 === '');
  // 短押しのA（記号=√）
  await page.keyboard.down('KeyA');
  await page.keyboard.up('KeyA');
  const afterShort = await page.evaluate(() => window.__neoApp.getActiveRow().mf.value);
  ok('記号優先時、短押しのAで√が入る', afterShort.includes('sqrt'), afterShort);
  // 元に戻す
  await page.click('#sidebar-toggle');
  await page.click('[data-settings-category="input"]');
  await page.click('#method-base-hold button:has-text("英字")');
  await page.click('#sidebar-close');

  console.log('\n== 7. 設定はリロード後も維持される ==');
  await page.click('#sidebar-toggle');
  await page.click('[data-settings-category="input"]');
  await page.click('.method-choice[data-input-method="hold"]');
  await page.click('#method-base-hold button:has-text("記号")');
  await page.reload({ waitUntil: 'networkidle' });
  const persisted = await page.evaluate(() => window.__neoApp.getMethodBaseLayer());
  ok('リロード後もhold=記号のまま', persisted.hold === 'symbol', persisted);

  ok('consoleエラー・警告なし', consoleIssues.length === 0, consoleIssues);

  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  await browser.close();
  process.exit(failures.length ? 1 : 0);
}

main();
