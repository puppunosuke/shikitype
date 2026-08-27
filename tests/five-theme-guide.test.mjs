// 5テーマ切替と、画面キー入力（Tab / Shiftを含む）の回帰検証。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
const THEMES = ['06', '08', '09', '13', '18'];
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

async function latex(page) {
  return page.evaluate(() => window.__neoApp.getActiveRow().mf.getValue());
}
async function startBlankNote(page) {
  await page.click('#new-note');
  await page.click('#new-note-create');
  await page.waitForTimeout(20);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.theme.v1'));
  await page.reload({ waitUntil: 'networkidle' });

  console.log('\n== 1. 5テーマを設定内だけで切り替えられる ==');
  await page.click('#sidebar-toggle');
  await page.click('[data-settings-category="appearance"]');
  ok('常設サイドバーにはテーマ一覧がなく、設定内の選択肢は5件', await page.locator('#theme-list').count() === 0
    && await page.locator('#sidebar-theme-choice .theme-choice').count() === 5);
  for (const id of THEMES) {
    await page.click('#sidebar-theme-choice .theme-choice[data-theme="' + id + '"]');
    const state = await page.evaluate((theme) => ({
      theme: document.body.dataset.theme,
      active: document.querySelector('#sidebar-theme-choice .theme-choice[data-theme="' + theme + '"]').getAttribute('aria-pressed'),
    }), id);
    ok(id + 'へ切替', state.theme === id && state.active === 'true', state);
  }
  await page.click('#sidebar-close');

  console.log('\n== 2. 画面キーが入力コアへ接続される ==');
  await page.reload({ waitUntil: 'networkidle' });
  await startBlankNote(page);
  await page.click('.row math-field');
  await page.click('#key-guide-board .key-cap[data-code="KeyU"]');
  ok('素キーUをクリックすると積分', (await latex(page)).includes('\\int'), await latex(page));

  await page.reload({ waitUntil: 'networkidle' });
  await startBlankNote(page);
  await page.click('.row math-field');
  await page.click('[data-special="Tab"]');
  ok('Tabを押すと英字・小文字層', await page.textContent('#key-guide-layer') === '英字・小文字');
  await page.click('[data-modifier="shift"]');
  ok('Shiftを押すと英字・大文字層', await page.textContent('#key-guide-layer') === '英字・大文字');
  ok('Shiftが押下状態', await page.getAttribute('[data-modifier="shift"]', 'aria-pressed') === 'true');
  await page.click('#key-guide-board .key-cap[data-code="KeyU"]');
  ok('英字層 Shift→Uで大文字U', await latex(page) === 'U', await latex(page));
  ok('1キー後に英字・小文字へ戻る', await page.textContent('#key-guide-layer') === '英字・小文字');

  await page.reload({ waitUntil: 'networkidle' });
  await startBlankNote(page);
  await page.click('.row math-field');
  await page.click('[data-special="Tab"]');
  await page.click('[data-modifier="shift"]');
  await page.keyboard.press('KeyU');
  ok('画面Shift→物理Uでも大文字U', await latex(page) === 'U', await latex(page));
  ok('交差入力後も1キーで小文字へ戻る', await page.textContent('#key-guide-layer') === '英字・小文字');

  await page.reload({ waitUntil: 'networkidle' });
  await startBlankNote(page);
  await page.click('.row math-field');
  await page.click('[data-special="Tab"]');
  await page.click('[data-special="Tab"]');
  await page.click('[data-modifier="shift"]');
  await page.keyboard.press('KeyG');
  ok('画面Shift→物理Gでギリシャ大文字Γ', await latex(page) === '\\Gamma ', await latex(page));
  await page.click('#key-guide-board .key-cap[data-code="KeyU"]');
  ok('次キーはギリシャ小文字υ', await latex(page) === '\\Gamma\\upsilon', await latex(page));
  ok('Altキーはガイドから廃止', await page.locator('[data-modifier="alt"]').count() === 0);

  console.log('\n== 3. 画面のSpace / Enterが入力状態を保つ ==');
  await page.reload({ waitUntil: 'networkidle' });
  await startBlankNote(page);
  await page.click('.row math-field');
  await page.click('#key-guide-board .key-cap[data-code="KeyF"]');
  ok('括弧クリックでスロットが開く', await page.evaluate(() => window.__neoApp.getActiveRow().stack.length) === 1);
  await page.click('[data-special="Space"]');
  ok('画面Spaceで1段閉じる', await page.evaluate(() => window.__neoApp.getActiveRow().stack.length) === 0);
  await page.click('[data-special="Enter"]');
  ok('画面Enterで次行', await page.locator('.row').count() === 2);
  const focused = await page.evaluate(() => {
    const mf = window.__neoApp.getActiveRow().mf;
    return document.activeElement === mf || mf.shadowRoot?.activeElement?.classList.contains('ML__keyboard-sink');
  });
  ok('クリック入力後も数式欄へフォーカス', focused);

  console.log('\n== 4. 5テーマ×3幅でガイドがはみ出さない ==');
  for (const width of [1024, 736, 360]) {
    await page.setViewportSize({ width, height: width === 360 ? 740 : 900 });
    for (const id of THEMES) {
      await page.evaluate((theme) => window.__neoApp.applyTheme(theme), id);
      await page.waitForTimeout(220);
      const geometry = await page.evaluate(() => {
        const guide = document.querySelector('#key-guide').getBoundingClientRect();
        const caps = [...document.querySelectorAll('#key-guide-board .key-cap')];
        const board = document.querySelector('#key-guide-board');
        return {
          horizontal: document.documentElement.scrollWidth <= window.innerWidth,
          guide: [guide.top, guide.bottom, guide.height],
          rowRects: [...document.querySelectorAll('#key-guide-board .key-row')].map((row) => {
            const r = row.getBoundingClientRect();
            return [r.top, r.bottom, r.height];
          }),
          capsInViewport: caps.every((cap) => {
            const r = cap.getBoundingClientRect();
            return r.left >= guide.left - 1 && r.right <= guide.right + 1;
          }),
          minCapWidth: Math.min(...caps.map((cap) => cap.getBoundingClientRect().width)),
          boardScrollable: board.scrollWidth > board.clientWidth,
          rowsVisible: [...document.querySelectorAll('#key-guide-board .key-row')].every((row) => {
            const r = row.getBoundingClientRect();
            return r.top >= guide.top - 1 && r.bottom <= guide.bottom + 1;
          }),
        };
      });
      const guideFits = width === 360
        ? geometry.boardScrollable && geometry.minCapWidth >= 44
        : geometry.capsInViewport;
      ok(id + ' / ' + width + 'px', geometry.horizontal && guideFits && geometry.rowsVisible, geometry);
    }
  }

  console.log('\n=== RESULT: ' + passed + ' passed, ' + failures.length + ' failed ===');
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  await browser.close();
  process.exit(failures.length ? 1 : 0);
}

main();
