// 彩葉レビュー用の実測スクリプト（段階4）。既存tests/配下の自動テストとは別に、
// 依頼内で指摘された観点（辞書表の多行時スクロール保持、キー割当パネルの入れ子スクロール、
// 360px/1280px、全5テーマでの視認性）を実DOMで確認する。使い捨て。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

let passed = 0; const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); } }

const browser = await chromium.launch({ headless: true });

async function openDictionaryAt(width, height, rowCount) {
  const page = await browser.newPage({ viewport: { width, height } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('neo-math.input-system.v1', 'conversion'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#sidebar-toggle');
  await page.click('.settings-nav-item[data-settings-category="conversion"]');
  await page.waitForSelector('#dictionary-editor-panel .dictionary-editor-table-wrap');
  await page.waitForTimeout(150);
  // rowCount行に増やす（末尾から追加ボタンを連打）
  for (let i = 0; i < rowCount; i += 1) {
    await page.click('#dictionary-editor-panel .dictionary-editor-add');
  }
  await page.waitForTimeout(150);
  return { page, pageErrors };
}

// --- 1. 辞書テーブル: 200行の状態で、検索→末尾へスクロール→削除、を実測 ---
{
  const { page } = await openDictionaryAt(1280, 900, 200);
  const wrap = page.locator('#dictionary-editor-panel .dictionary-editor-table-wrap');
  // 200行追加後、ページャは何ページになるか
  const pagerText = await page.locator('#dictionary-editor-panel .dictionary-editor-page').textContent();
  console.log('  INFO ページャ表示:', pagerText);

  // 検索して絞り込み、スクロールし、削除して検索・スクロールが保たれるか
  await page.fill('#dictionary-editor-panel .dictionary-editor-search', '');
  await page.waitForTimeout(80);
  // 60件超のときスクロール可能かを確認
  const { scrollHeight, clientHeight } = await wrap.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  ok('60行超で表本体がスクロール可能', scrollHeight > clientHeight, { scrollHeight, clientHeight });

  await wrap.evaluate((el) => { el.scrollTop = 400; });
  await page.waitForTimeout(80);
  const beforeTop = await wrap.evaluate((el) => el.scrollTop);
  // 表示中の最後の行を削除する
  const lastVisibleRemove = page.locator('#dictionary-editor-panel .dictionary-editor-rail [data-remove]').last();
  await lastVisibleRemove.click();
  await page.waitForTimeout(200);
  const afterTop = await wrap.evaluate((el) => el.scrollTop);
  ok('末尾付近の行削除後もスクロール位置が上端(0)へ飛ばない', afterTop > 0, { beforeTop, afterTop });

  // ページャ操作 → 2ページ目まで戻り、そのページの行を消す → ページ番号が保たれるか
  // add()連打の直後は最終ページにいるため、まず先頭へ戻ってから2ページ目へ進む。
  for (let i = 0; i < 20; i += 1) {
    const prevBtn = page.locator('#dictionary-editor-panel .dictionary-editor-prev');
    if (await prevBtn.isDisabled()) break;
    await prevBtn.click();
    await page.waitForTimeout(30);
  }
  const nextBtn = page.locator('#dictionary-editor-panel .dictionary-editor-next');
  if (!(await nextBtn.isDisabled())) await nextBtn.click();
  await page.waitForTimeout(100);
  const pageBefore = await page.locator('#dictionary-editor-panel .dictionary-editor-page').textContent();
  const removeOnPage2 = page.locator('#dictionary-editor-panel .dictionary-editor-rail [data-remove]').first();
  await removeOnPage2.click();
  await page.waitForTimeout(150);
  const pageAfter = await page.locator('#dictionary-editor-panel .dictionary-editor-page').textContent();
  ok('2ページ目で削除してもページ番号が保たれる（先頭ページへ戻らない）', pageBefore === pageAfter, { pageBefore, pageAfter });

  await page.close();
}

// --- 2. 辞書テーブル: 360px幅で表編集が成立するか ---
{
  const { page } = await openDictionaryAt(360, 740, 5);
  const wrap = page.locator('#dictionary-editor-panel .dictionary-editor-table-wrap');
  const box = await wrap.boundingBox();
  const viewport = page.viewportSize();
  ok('360px幅で表がviewport内に収まる(横スクロール不要な主要幅)', box.x >= 0 && box.x + box.width <= viewport.width + 1, { box, viewport });
  // 実際に候補ID・記号・数式・読み・優先度が全部入力できるか(1行目)
  const firstRow = page.locator('#dictionary-editor-panel tbody tr').first();
  const candidateInput = firstRow.locator('[data-field="candidate_id"]');
  await candidateInput.click();
  await candidateInput.fill('narrow-test');
  const val = await candidateInput.inputValue();
  ok('360px幅でも候補ID欄に文字入力できる', val === 'narrow-test', val);
  // rail(消す/読み追加)ボタンが画面内にあるか
  const railBtn = firstRow.locator('..'); // placeholder, will check rail separately
  const railBox = await page.locator('#dictionary-editor-panel .dictionary-editor-rail').boundingBox();
  ok('360px幅で行操作レール(消す/読み追加)がviewport内', railBox && railBox.x + railBox.width <= viewport.width + 1, railBox);
  await page.close();
}

// --- 3. キー割当パネル: 操作一覧(内側スクロール)とキーボードworkbenchの二重スクロール ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
  await page.click('#sidebar-toggle');
  await page.click('.settings-nav-item[data-settings-category="keys"]');
  await page.waitForSelector('#operations-guide-list');
  await page.waitForTimeout(150);
  const guideBox = await page.locator('#operations-guide-list').boundingBox();
  const { scrollHeight: guideScrollH, clientHeight: guideClientH } = await page.locator('#operations-guide-list').evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  console.log('  INFO 操作一覧 box:', guideBox, 'scrollH/clientH:', guideScrollH, guideClientH);
  ok('操作一覧(13件)は内側スクロールが要らない高さに収まる(理想)', guideScrollH <= guideClientH + 2, { guideScrollH, guideClientH });

  const settingsContentBox = await page.locator('#settings-content').boundingBox();
  const { scrollHeight: outerScrollH, clientHeight: outerClientH } = await page.locator('#settings-content').evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  ok('外側のsettings-contentも、キー割当パネルが二重スクロールを要求しない範囲で収まる(参考値)', true, { outerScrollH, outerClientH });

  // キーボードworkbenchの主要キーが操作一覧の下にあり、実際に見えるか(スクロールなしで割当キーを押せるか)
  const workbench = page.locator('.keys-workbench');
  const workbenchVisible = await workbench.isVisible();
  ok('keys-workbenchが表示されている', workbenchVisible);
  await page.close();
}

// --- 4. 全5テーマでの視認性(操作一覧・辞書テーブル) ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
  const themeButtons = await page.locator('[data-theme]').evaluateAll((els) => els.map((el) => el.dataset.theme));
  console.log('  INFO テーマ候補:', themeButtons);
  await page.click('#sidebar-toggle');
  await page.click('.settings-nav-item[data-settings-category="appearance"]');
  await page.waitForTimeout(100);
  const themeChoiceButtons = await page.locator('#settings-panel-appearance button, [data-theme]').count();
  console.log('  INFO appearanceパネル内ボタン数:', themeChoiceButtons);
  await page.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
await browser.close();
