// 段階4-7: 設定モーダルへ組み込んだ読み辞書エディタ（dictionary-table.js）の検証。
// CSVの往復（書き出し→単体HTML→読み込み）を経ず、設定内でそのまま
// 追加・編集・削除ができること、単体HTML（tools/reading-dictionary-csv-editor.html）が
// 生んだ既存の操作感（削除後にスクロール位置を保つ・読みを空にした複製行の直下挿入・
// 検索での絞り込み）を、実DOM操作で確認する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

let passed = 0; const failures = [];
function ok(label, value, detail = value) { if (value) { passed++; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); } }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('neo-math.input-system.v1', 'conversion'));
await page.reload({ waitUntil: 'networkidle' });
await page.click('#sidebar-toggle');
await page.click('.settings-nav-item[data-settings-category="conversion"]');
await page.waitForSelector('#dictionary-editor-panel .dictionary-editor-table-wrap');
await page.locator('#dictionary-editor-panel').scrollIntoViewIfNeeded();
await page.waitForTimeout(200);

// 1. マウント直後から、非表示カテゴリで初期化されていても削除レールが実際にクリックできる高さを持つ
//   （高さ0のまま固まる回帰を防ぐResizeObserverの検証）。
const railHeight = await page.evaluate(() => document.querySelector('.dictionary-editor-rail').getBoundingClientRect().height);
ok('削除レールは表示後に実寸の高さを持つ（0のまま固まらない）', railHeight > 100, railHeight);

// 2. 行を追加して保存すると、実際にconversionDictionaryへ反映される。
await page.click('#dictionary-editor-panel .dictionary-editor-add');
await page.waitForTimeout(80);
const newIndex = await page.evaluate(() => document.activeElement?.dataset?.index);
const sel = (field) => `#dictionary-editor-panel [data-field="${field}"][data-index="${newIndex}"]`;
await page.fill(sel('candidate_id'), 'custom-e1b4test');
await page.fill(sel('symbol'), 'Q');
await page.fill(sel('latex'), 'Q');
await page.fill(sel('reading'), 'いーびーよんてすと');
await page.fill(sel('base_priority'), '10');
await page.locator(sel('base_priority')).dispatchEvent('change');
await page.waitForTimeout(80);
const applyEnabled = await page.locator('#dictionary-editor-panel .dictionary-editor-apply').isEnabled();
ok('妥当な行を入力すると保存ボタンが有効になる', applyEnabled);
await page.click('#dictionary-editor-panel .dictionary-editor-apply');
await page.waitForTimeout(200);
const savedToDictionary = await page.evaluate(() => (localStorage.getItem('neo-math.conversion-dictionary.v1') || '').includes('custom-e1b4test'));
ok('表からの追加が読み辞書へ反映される（往復不要）', savedToDictionary);

// 3. 削除後、一覧の表示位置が先頭へ飛ばない（彩葉の恒常ルール）。
const wrap = page.locator('#dictionary-editor-panel .dictionary-editor-table-wrap');
await wrap.evaluate((el) => { el.scrollTop = 200; });
await page.waitForTimeout(120);
const scrollBefore = await wrap.evaluate((el) => el.scrollTop);
const visibleRemoveIndex = await page.evaluate(() => {
  const rail = document.querySelector('.dictionary-editor-rail').getBoundingClientRect();
  const button = [...document.querySelectorAll('[data-remove]')].find((b) => { const r = b.getBoundingClientRect(); return r.top >= rail.top && r.bottom <= rail.bottom; });
  return button ? button.dataset.remove : null;
});
await page.click(`#dictionary-editor-panel [data-remove="${visibleRemoveIndex}"]`);
await page.waitForTimeout(120);
const scrollAfter = await wrap.evaluate((el) => el.scrollTop);
ok('行を消しても一覧は先頭へ飛ばない', scrollAfter > 50, { scrollBefore, scrollAfter });

// 4. 「読み追加」は直下へ複製し、読みだけ空にしてフォーカスする。
await wrap.evaluate((el) => { el.scrollTop = 0; });
await page.waitForTimeout(80);
const before = await page.locator('#dictionary-editor-panel tbody tr').nth(0).locator('[data-field="candidate_id"]').inputValue();
await page.click('#dictionary-editor-panel [data-insert-reading="0"]');
await page.waitForTimeout(120);
const after1 = page.locator('#dictionary-editor-panel tbody tr').nth(1);
const afterCandidate = await after1.locator('[data-field="candidate_id"]').inputValue();
const afterReading = await after1.locator('[data-field="reading"]').inputValue();
const focusedField = await page.evaluate(() => document.activeElement?.dataset?.field);
ok('読み追加は直下複製かつ読みだけ空にする', before === afterCandidate && afterReading === '', { before, afterCandidate, afterReading });
ok('読み追加後は複製行の読み欄へフォーカスする', focusedField === 'reading', focusedField);

// 5. 検索は表の行を絞り込む。
await page.fill('#dictionary-editor-panel .dictionary-editor-search', 'integral');
await page.waitForTimeout(120);
const filteredRows = await page.locator('#dictionary-editor-panel tbody tr').count();
const firstFiltered = await page.locator('#dictionary-editor-panel tbody tr').first().locator('[data-field="candidate_id"]').inputValue();
ok('検索欄で行を絞り込める', filteredRows > 0 && filteredRows < 60 && firstFiltered.includes('integral'), { filteredRows, firstFiltered });
await page.fill('#dictionary-editor-panel .dictionary-editor-search', '');
await page.waitForTimeout(80);

// 6. 単体HTML（tools/reading-dictionary-csv-editor.html）は今までどおり単体で動く（file://を模した直接オープン）。
const toolPage = await browser.newPage();
const toolErrors = [];
toolPage.on('pageerror', (error) => toolErrors.push(error.message));
await toolPage.goto('http://localhost:8893/tools/reading-dictionary-csv-editor.html', { waitUntil: 'networkidle' });
const toolSelfTest = await toolPage.evaluate(() => window.SHIKITYPE_CSV_EDITOR?.runLogicTests?.());
ok('単体HTMLの自己診断は全通過（このチケットで一切変更していない）', Array.isArray(toolSelfTest) && toolSelfTest.length > 0 && toolSelfTest.every((item) => item.pass), toolSelfTest);
await toolPage.click('#sample');
await toolPage.waitForTimeout(80);
const toolRows = await toolPage.locator('#rows tr').count();
ok('単体HTMLは単独でサンプルCSVを読み込める', toolRows === 3, toolRows);
ok('単体HTMLにページエラーなし', toolErrors.length === 0, toolErrors);
await toolPage.close();

ok('設定パネル側にもページエラーなし', pageErrors.length === 0, pageErrors);
await browser.close();

console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
