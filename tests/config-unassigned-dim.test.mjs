// 薄表示は、設定で選んだキーへの「未使用の割り当て候補」だけに限定する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
const THEMES = ['06', '08', '09', '13', '18'];
const LAYERS = ['symbol', 'latin', 'greek'];
// 実画面で薄くなっていた単元外キー。/ はSlashの物理キー。
const NORMAL_KEYS = ['KeyW', 'KeyR', 'KeyY', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Slash'];
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log('  OK  ' + label); }
  else { failures.push({ label, detail }); console.log('  FAIL ' + label + ': ' + JSON.stringify(detail)); }
}

async function selectGuideLayer(page, layer) {
  await page.evaluate((target) => {
    for (let i = 0; i < 3 && window.__neoApp.getBaseLayer() !== target; i++) {
      window.__neoApp.handleVirtualSpecial('Tab');
    }
  }, layer);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (err) => failures.push({ label: 'pageerror', detail: err.message }));
  const consoleIssues = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push({ type: message.type(), text: message.text() });
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#sidebar-toggle');
  await page.click('[data-settings-category="keys"]');

  console.log('\n== 通常キー面は未割当・単元外・disabledでも薄くしない ==');
  for (const theme of THEMES) {
    await page.click('[data-settings-category="appearance"]');
    await page.click(`#sidebar-theme-choice [data-theme="${theme}"]`);
    await page.click('[data-settings-category="keys"]');
    for (const layer of LAYERS) {
      await page.click(`#layer-choice [data-choice-value="${layer}"]`);
      await selectGuideLayer(page, layer);
      const state = await page.evaluate(({ keys, layerId }) => {
        const style = (el) => {
          const css = getComputedStyle(el);
          return { opacity: css.opacity, filter: css.filter, color: css.color, background: css.backgroundColor };
        };
        const compare = (selector) => {
          const root = document.querySelector(selector);
          const ref = root.querySelector('.key-cap[data-code="KeyA"]');
          return Object.fromEntries(keys.map((code) => {
            const el = root.querySelector(`.key-cap[data-code="${code}"]`);
            return [code, { style: style(el), reference: style(ref), outOfUnit: el.classList.contains('out-of-unit'), disabled: !!el.disabled }];
          }));
        };
        return { layerId, guide: compare('#key-guide-board'), config: compare('#config-keys') };
      }, { keys: NORMAL_KEYS, layerId: layer });
      const equalNormalSurface = (entries) => Object.values(entries).every(({ style, reference }) => (
        style.opacity === '1' && style.filter === 'none'
        && style.color === reference.color && style.background === reference.background
      ));
      ok(`${theme}/${layer}: W,R,Y,V,B,N,M,/ の通常キーガイドは割当済みと同じ濃さ`, equalNormalSurface(state.guide), state);
      ok(`${theme}/${layer}: W,R,Y,V,B,N,M,/ の設定物理キーは割当済みと同じ濃さ`, equalNormalSurface(state.config), state);
    }
  }

  // disabled表現も薄さではなく、操作上の属性と輪郭だけにする。
  await page.click('#layer-choice [data-choice-value="greek"]');
  await selectGuideLayer(page, 'greek');
  const disabled = await page.evaluate(() => {
    const el = document.querySelector('#key-guide-board .key-cap[data-code="KeyJ"]');
    const css = getComputedStyle(el);
    return { disabled: el.disabled, aria: el.getAttribute('aria-disabled'), opacity: css.opacity, filter: css.filter, borderStyle: css.borderStyle, cursor: css.cursor };
  });
  ok('操作不可キーも薄くせず、属性・破線・カーソルでだけ示す', disabled.disabled && disabled.aria === 'true'
    && disabled.opacity === '1' && disabled.filter === 'none' && disabled.borderStyle === 'dashed' && disabled.cursor === 'not-allowed', disabled);

  // 実際に薄くなるのは、物理キーを選んだ後の未使用候補だけ。
  await page.click('#layer-choice [data-choice-value="symbol"]');
  await page.click('#config-keys .key-cap[data-code="KeyT"]');
  const candidates = await page.evaluate(() => ({
    dimmed: document.querySelectorAll('#assign-grid .unassigned-candidate').length,
    current: document.querySelectorAll('#assign-grid .current-assignment').length,
    overlap: document.querySelectorAll('#assign-grid .current-assignment.unassigned-candidate').length,
    configDimmed: document.querySelectorAll('#config-keys .unassigned-candidate').length,
    guideDimmed: document.querySelectorAll('#key-guide-board .unassigned-candidate').length,
  }));
  ok('未使用の割り当て候補だけを控えめに表示する', candidates.dimmed > 0 && candidates.configDimmed === 0 && candidates.guideDimmed === 0, candidates);
  ok('現在の割り当て候補は薄表示より優先して明確に強調する', candidates.current === 1 && candidates.overlap === 0, candidates);
  ok('consoleエラー・警告なし', consoleIssues.length === 0, consoleIssues);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
