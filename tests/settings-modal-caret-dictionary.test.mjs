import { chromium } from '../spike/node_modules/playwright/index.mjs';
import { CONVERSION_CANDIDATES, effectiveConversionCandidates, rankConversionCandidates } from '../conversion.js';

let passed = 0; const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); } }

const ids = CONVERSION_CANDIDATES.map((candidate) => candidate.id);
ok('既定辞書は100件以上かつIDが一意', CONVERSION_CANDIDATES.length >= 100 && new Set(ids).size === ids.length, { candidates: CONVERSION_CANDIDATES.length, aliases: CONVERSION_CANDIDATES.reduce((total, candidate) => total + candidate.aliases.length, 0), duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index) });
ok('CSV相当の重複IDを既定候補へ重ねない', effectiveConversionCandidates({ additions: { integral: { id: 'integral', label: '×', latex: 'x', basePriority: 1, aliases: ['x'] } } }).filter((candidate) => candidate.id === 'integral').length === 1);
ok('Latin raw pはPを最優先し小文字は明示alias経由', rankConversionCandidates('p').filter((candidate) => candidate.categories?.includes('latin')).map((candidate) => candidate.id).join(',') === 'latin-uppercase-p');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('neo-math.input-system.v1', 'conversion'));
await page.reload({ waitUntil: 'networkidle' });

await page.focus('.row-input-proxy');
const before = await page.evaluate(() => ({ caret: document.querySelector('.conversion-caret')?.hidden === false, proxy: document.activeElement?.className, sink: document.querySelector('math-field')?.shadowRoot?.activeElement?.className || '' }));
ok('変換入力はproxy focusのまま視覚caretを出す', before.caret && String(before.proxy).includes('row-input-proxy') && !String(before.sink).includes('keyboard-sink'), before);
ok('行modeの変換数式は可視caretを常に1本だけにする', await page.locator('.conversion-caret:not([hidden])').count() === 1);
await page.keyboard.press('KeyI'); await page.keyboard.press('KeyN'); await page.keyboard.press('KeyT');
const caretAfterTyping = await page.evaluate(() => ({ caret: document.querySelector('.conversion-caret')?.getBoundingClientRect().toJSON(), preview: document.querySelector('.conversion-reading')?.textContent }));
ok('変換中のcaretとASCII previewが維持される', caretAfterTyping.caret.width > 0 && caretAfterTyping.preview === 'int', caretAfterTyping);

const opener = await page.locator('#sidebar-toggle'); await opener.click();
const modal = await page.evaluate(() => ({ open: document.getElementById('sidebar')?.open, panels: [...document.querySelectorAll('.settings-panel')].map((panel) => [panel.id, panel.hidden]), parents: ['input-system-section','layout-mode-section','legacy-input-method-section','conversion-priority-section','conversion-dictionary-section','legacy-method-base-section'].map((id) => [id, document.getElementById(id)?.closest('.settings-panel')?.id]), caretHidden: document.querySelector('.conversion-caret')?.hidden }));
ok('設定はnative modalで、カテゴリ所属とcaret遮蔽を保つ', modal.open && modal.caretHidden && JSON.stringify(modal.parents) === JSON.stringify([['input-system-section','settings-panel-basic'],['layout-mode-section','settings-panel-basic'],['legacy-input-method-section','settings-panel-input'],['conversion-priority-section','settings-panel-conversion'],['conversion-dictionary-section','settings-panel-conversion'],['legacy-method-base-section','settings-panel-input']]), modal);
await page.focus('#sidebar-close'); await page.keyboard.press('Tab');
const dialogTab = await page.evaluate(() => ({ focused: document.activeElement?.id, baseLayer: window.__neoApp.getBaseLayer(), inside: document.getElementById('sidebar')?.contains(document.activeElement) }));
ok('設定modal中のTabは数式層を奪わず次の設定操作へ進む', dialogTab.focused === 'settings-search' && dialogTab.baseLayer === 'symbol' && dialogTab.inside, dialogTab);
await page.click('[data-settings-category="conversion"]');
const conversionPanel = await page.evaluate(() => ({ conversion: !document.getElementById('settings-panel-conversion').hidden, listMax: getComputedStyle(document.getElementById('conversion-priority-list')).maxHeight, rows: document.querySelectorAll('#conversion-priority-list > *').length }));
ok('変換順位はbounded listで全辞書を縦積みしない', conversionPanel.conversion && conversionPanel.listMax !== 'none' && conversionPanel.rows <= 12, conversionPanel);
await page.focus('#settings-search'); await page.keyboard.type('辞書'); await page.locator('.settings-search-result').first().click();
await page.waitForTimeout(40);
const searchJump = await page.evaluate(() => {
  const content = document.getElementById('settings-content').getBoundingClientRect(); const target = document.getElementById('conversion-dictionary-section').getBoundingClientRect();
  return { category: !document.getElementById('settings-panel-conversion').hidden, scrollTop: document.getElementById('settings-content').scrollTop, visible: target.top >= content.top && target.bottom <= content.bottom + 1, highlighted: document.getElementById('conversion-dictionary-section').classList.contains('settings-search-hit') };
});
ok('設定検索でCSV節へ移動して一時強調する', searchJump.category && searchJump.scrollTop > 0 && searchJump.visible && searchJump.highlighted, searchJump);
await page.click('[data-settings-category="basic"]'); await page.click('.input-system-choice[data-input-system="legacy"]');
const legacySettings = await page.evaluate(() => {
  const nav = document.querySelector('.settings-nav-item[data-settings-category="conversion"]');
  document.getElementById('settings-search').value = '辞書'; document.getElementById('settings-search').dispatchEvent(new Event('input', { bubbles: true }));
  return { hidden: nav?.hidden, tabIndex: nav?.tabIndex, current: document.querySelector('.settings-nav-item[aria-current="page"]')?.dataset.settingsCategory, search: document.querySelectorAll('.settings-search-result').length };
});
ok('従来方式では空の変換カテゴリをnav・検索・Tab順から外す', legacySettings.hidden && legacySettings.current !== 'conversion' && legacySettings.search === 0, legacySettings);
ok('legacyでは変換caretをすべて隠す', await page.locator('.conversion-caret:not([hidden])').count() === 0);
await page.click('.input-system-choice[data-input-system="conversion"]');
ok('変換方式へ戻すと変換カテゴリを再表示する', await page.locator('.settings-nav-item[data-settings-category="conversion"]').evaluate((el) => !el.hidden));
await page.keyboard.press('Escape');
const restored = await page.evaluate(() => ({ open: document.getElementById('sidebar')?.open, proxy: document.activeElement?.className, caret: document.querySelector('.conversion-caret')?.hidden === false }));
ok('Escで閉じて数式proxy/caretへ戻る', !restored.open && String(restored.proxy).includes('row-input-proxy') && restored.caret, restored);
ok('modalを閉じた変換数式はcaretを1本だけ復帰する', await page.locator('.conversion-caret:not([hidden])').count() === 1);
await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'text' })); await page.waitForTimeout(40);
ok('文入力中は変換caretを表示しない', await page.locator('.conversion-caret:not([hidden])').count() === 0);
await page.keyboard.press('Enter'); await page.waitForTimeout(40);
ok('文を閉じると変換caretを1本だけ再表示する', await page.locator('.conversion-caret:not([hidden])').count() === 1);

await page.setViewportSize({ width: 360, height: 800 }); await page.click('#sidebar-toggle');
const mobile = await page.evaluate(() => ({ layout: getComputedStyle(document.querySelector('.settings-layout')).gridTemplateColumns, nav: getComputedStyle(document.querySelector('.settings-nav-list')).display, overflow: document.documentElement.scrollWidth <= innerWidth }));
ok('狭幅はカテゴリnavを上部tabsへ再配置し横overflowしない', mobile.layout !== '256px 1fr' && mobile.nav === 'flex' && mobile.overflow, mobile);
await page.locator('#sidebar-close').click();
await browser.close();
ok('ページエラーなし', pageErrors.length === 0, pageErrors);
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
