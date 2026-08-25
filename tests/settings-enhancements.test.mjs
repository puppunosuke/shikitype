// 設定導線・左レール折り畳み・主要幅の回帰検証。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log('  OK  ' + label); }
  else { failures.push({ label, detail }); console.log('  FAIL ' + label + ': ' + JSON.stringify(detail)); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (err) => failures.push({ label: 'pageerror', detail: err.message }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    for (const key of ['neo-math.notes.v1', 'neo-math.theme-rail-collapsed.v1']) localStorage.removeItem(key);
  });
  await page.reload({ waitUntil: 'networkidle' });

  const identity = await page.evaluate(() => ({
    title: document.title,
    mark: document.getElementById('product-mark')?.getAttribute('aria-label'),
    titleBlock: document.getElementById('title-block'),
    themeList: document.getElementById('theme-list'),
    settingsLabel: document.getElementById('sidebar-toggle')?.getAttribute('aria-label'),
    drawerLabel: document.getElementById('sidebar')?.getAttribute('aria-labelledby'),
    drawerHeading: document.querySelector('#sidebar-head h2')?.textContent,
  }));
  ok('SHIKITYPEは左ブランドだけに残し、常設テーマ一覧を置かない', identity.title === 'SHIKITYPE' && identity.mark === 'SHIKITYPE' && !identity.titleBlock && !identity.themeList, identity);
  ok('ユーザー向け名称を設定へ統一', identity.settingsLabel === '設定' && identity.drawerLabel === 'settings-title' && identity.drawerHeading === '設定', identity);

  await page.click('#sidebar-toggle');
  await page.click('[data-settings-category="appearance"]');
  ok('デザインは設定内だけに5件ある', await page.locator('#sidebar-theme-choice .theme-choice').count() === 5);
  await page.click('#sidebar-theme-choice .theme-choice[data-theme="13"]');
  ok('設定からデザインを切替できる', await page.evaluate(() => document.body.dataset.theme === '13'));
  await page.click('#sidebar-close');

  for (const width of [1024, 736, 360]) {
    await page.setViewportSize({ width, height: width === 360 ? 800 : 900 });
    const layout = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth <= window.innerWidth,
      notes: document.getElementById('note-actions').getBoundingClientRect().width > 0,
      settings: document.getElementById('sidebar-toggle').getBoundingClientRect().width > 0,
    }));
    ok(`${width}pxで左のノート・設定操作が画面内にある`, layout.horizontal && layout.notes && layout.settings, layout);
  }

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.click('#theme-rail-collapse');
  const collapsed = await page.evaluate(() => ({
    collapsed: document.body.classList.contains('theme-rail-collapsed'),
    railWidth: Math.round(document.getElementById('theme-sidebar').getBoundingClientRect().width),
    notesHidden: getComputedStyle(document.getElementById('note-actions')).display === 'none',
    settingsHidden: getComputedStyle(document.getElementById('sidebar-toggle')).display === 'none',
    handleCentered: Math.abs((document.getElementById('theme-rail-collapse').getBoundingClientRect().top + document.getElementById('theme-rail-collapse').getBoundingClientRect().bottom) / 2 - innerHeight / 2) < 1,
  }));
  ok('畳むと左レールを完全に隠し中央の開閉ボタンだけを残す', collapsed.collapsed && collapsed.railWidth === 0 && collapsed.notesHidden && collapsed.settingsHidden && collapsed.handleCentered, collapsed);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
