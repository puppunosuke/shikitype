// 4入力方式の切替・保存・実入力・レスポンシブ回帰。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
const METHODS = ['toggle', 'math', 'hybrid', 'hold'];
const THEMES = ['06', '08', '09', '13', '18'];
let pass = 0;
const failures = [];

function ok(label, value, detail = value) {
  if (value) { pass++; console.log('  OK  ' + label); }
  else { failures.push({ label, detail }); console.log('  FAIL ' + label + ': ' + JSON.stringify(detail)); }
}

async function latex(page) {
  return page.evaluate(() => window.__neoApp.getActiveRow().mf.getValue());
}

async function reset(page) {
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    row.mf.value = '';
    row.stack = [];
    row.run = [];
    row.history = [];
    row.runStack = [];
    row.mf.focus();
  });
  await page.waitForTimeout(40);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (err) => failures.push({ label: 'pageerror', detail: err.message }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.input-method.v1'));
  await page.reload({ waitUntil: 'networkidle' });

  console.log('\n== 1. 設定で4方式を選べて保存される ==');
  ok('狭幅でも設定ボタンに名前がある', await page.getAttribute('#sidebar-toggle', 'aria-label') === '設定');
  await page.click('#sidebar-toggle');
  await page.click('[data-settings-category="input"]');
  ok('方式は4件', await page.locator('.method-choice').count() === 4);
  ok('初期値は標準トグル', await page.getAttribute('.method-choice[data-input-method="toggle"]', 'aria-pressed') === 'true');
  await page.click('.method-choice[data-input-method="math"]');
  ok('数式常駐へ切替', await page.evaluate(() => document.body.dataset.inputMethod) === 'math');
  ok('数式常駐は英字層から開始', await page.evaluate(() => window.__neoApp.getBaseLayer()) === 'latin');
  ok('方式選択後も設定側にフォーカス', await page.evaluate(() => document.querySelector('#sidebar').contains(document.activeElement)));
  await page.keyboard.press('Tab');
  ok('設定中のTabで入力層を変えない', await page.evaluate(() => window.__neoApp.getBaseLayer()) === 'latin');
  ok('設定中のTabは次の設定項目へ進む', await page.evaluate(() => document.querySelector('#sidebar').contains(document.activeElement)));
  await page.click('#sidebar-close');
  ok('従来方式で設定を閉じると編集中の数式へ焦点を戻す', await page.evaluate(() => document.activeElement?.tagName === 'MATH-FIELD'));
  await page.reload({ waitUntil: 'networkidle' });
  ok('再読み込み後も数式常駐', await page.evaluate(() => window.__neoApp.getInputMethod()) === 'math');

  console.log('\n== 2. 数式常駐は頻出記号を直接入力 ==');
  ok('常駐記号は10件', await page.locator('#resident-symbols .resident-key').count() === 10);
  ok('掛け算表示はセンタードット', await page.locator('#resident-symbols .resident-key').filter({ hasText: '·' }).count() === 1);
  ok('日本語の中黒は使わない', (await page.textContent('#resident-symbols')).includes('・') === false);
  await page.click('.row math-field');
  await page.click('#resident-symbols .resident-key:has-text("·")');
  ok('常駐·はLaTeXのcdot', await latex(page) === '\\cdot ', await latex(page));
  await reset(page);
  await page.click('#resident-symbols .resident-key:has-text("n/α")');
  ok('常駐分数でスロットが開く', await page.evaluate(() => window.__neoApp.getActiveRow().stack[0]?.kind) === 'nfrac');

  console.log('\n== 3. 一時＋固定を使い分ける ==');
  await page.evaluate(() => window.__neoApp.setInputMethod('hybrid'));
  await reset(page);
  await page.click('[data-special="Tab"]');
  ok('Tabは英字の一時層', await page.textContent('#key-guide-layer') === '英字・小文字・一時');
  await page.click('#key-guide-board .key-cap[data-code="KeyX"]');
  ok('一時層でxが入る', await latex(page) === 'x', await latex(page));
  ok('1入力後は固定中の記号へ戻る', await page.textContent('#key-guide-layer') === '記号');
  await page.click('[data-special="Tab"]');
  await page.click('#layer-lock');
  ok('英字層を固定', await page.evaluate(() => window.__neoApp.getLockedLayer()) === 'latin');
  await page.click('#key-guide-board .key-cap[data-code="KeyX"]');
  await page.click('#key-guide-board .key-cap[data-code="KeyY"]');
  ok('固定後は連続でxy', await latex(page) === 'xxy', await latex(page));
  ok('連続入力後も英字層', await page.textContent('#key-guide-layer') === '英字・小文字');

  console.log('\n== 4. 長押しは短押し文字・長押し記号 ==');
  await page.evaluate(() => window.__neoApp.setInputMethod('hold'));
  await reset(page);
  await page.keyboard.press('KeyT');
  ok('物理T短押しはt', await latex(page) === 't', await latex(page));
  await reset(page);
  await page.keyboard.down('KeyT');
  ok('物理Tの押下中アニメーション', await page.locator('#key-guide-board .key-cap[data-code="KeyT"]').evaluate((el) => el.classList.contains('is-holding')));
  await page.waitForTimeout(500);
  ok('物理Tの長押し成立アニメーション', await page.locator('#key-guide-board .key-cap[data-code="KeyT"]').evaluate((el) => el.classList.contains('is-long-fired')));
  await page.keyboard.up('KeyT');
  ok('物理T長押しはセンタードット', await latex(page) === '\\cdot ', await latex(page));
  await reset(page);
  await page.click('#key-guide-board .key-cap[data-code="KeyG"]');
  ok('画面G短押しはg', await latex(page) === 'g', await latex(page));
  await reset(page);
  const g = page.locator('#key-guide-board .key-cap[data-code="KeyG"]');
  await g.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true });
  ok('画面Gの押下中アニメーション', await g.evaluate((el) => el.classList.contains('is-holding')));
  await page.waitForTimeout(500);
  ok('画面Gの長押し成立アニメーション', await g.evaluate((el) => el.classList.contains('is-long-fired')));
  await g.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true });
  ok('画面G長押しは+', await latex(page) === '+', await latex(page));
  await reset(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('KeyA');
  ok('長押し方式のTabは英字→ギリシャ', await latex(page) === '\\alpha ', await latex(page));

  console.log('\n== 5. 4方式×5テーマ×3幅で入力面が崩れない ==');
  for (const width of [1024, 736, 360]) {
    await page.setViewportSize({ width, height: width === 360 ? 740 : 900 });
    for (const method of METHODS) {
      await page.evaluate((id) => window.__neoApp.setInputMethod(id, false), method);
      await page.waitForTimeout(220);
      for (const theme of THEMES) {
        await page.evaluate((id) => window.__neoApp.applyTheme(id, false), theme);
        await page.waitForTimeout(180);
        const geometry = await page.evaluate(() => {
          const guide = document.querySelector('#key-guide').getBoundingClientRect();
          const rows = [...document.querySelectorAll('#key-guide-board .key-row')];
          return {
            horizontal: document.documentElement.scrollWidth <= window.innerWidth,
            rowsVisible: rows.every((row) => {
              const r = row.getBoundingClientRect();
              return r.top >= guide.top - 1 && r.bottom <= guide.bottom + 1;
            }),
            residentVisible: getComputedStyle(document.getElementById('resident-symbols')).display !== 'none',
          };
        });
        const residentCorrect = method === 'math' ? geometry.residentVisible : !geometry.residentVisible;
        ok(`${method}/${theme}/${width}px`, geometry.horizontal && geometry.rowsVisible && residentCorrect, geometry);
      }
    }
  }

  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => window.__neoApp.setInputMethod('math', false));
  await page.waitForTimeout(220);
  ok('360pxの常駐記号は高さ38px', await page.locator('.resident-key').evaluateAll((els) => els.every((el) => el.getBoundingClientRect().height >= 38)));
  ok('360pxの補助キーは高さ38px', await page.locator('.modifier-key, .action-key').evaluateAll((els) => els.filter((el) => getComputedStyle(el).display !== 'none').every((el) => el.getBoundingClientRect().height >= 38)));

  console.log(`\n=== RESULT: ${pass} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  await browser.close();
  process.exit(failures.length ? 1 : 0);
}

main();
