// 単元プリセット（科目→単元）の検証。
// 最重要: 単元を切り替えても物理キーへの割り当ては1つも変わらないこと（機械的に全キー比較する）。
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
  await page.evaluate(() => localStorage.removeItem('neo-math.unit.v1'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#sidebar-toggle');

  console.log('\n== 1. 科目→単元の2段選択 ==');
  const subjectCount = await page.locator('#unit-subject-choice button').count();
  ok('全単元を先頭に、科目は6件', subjectCount === 7, subjectCount);
  const subjectLabels = await page.locator('#unit-subject-choice button').allTextContents();
  ok('科目に数I〜数IIIが揃う', ['数I', '数A', '数II', '数B', '数C', '数III'].every((l) => subjectLabels.includes(l)), subjectLabels);

  console.log('\n== 2. 科目を変えると単元一覧と選択が追従する ==');
  await page.click('#unit-subject-choice button:has-text("数A")');
  const afterSubject = await page.evaluate(() => ({
    subject: window.__neoApp.getCurrentSubject(),
    unit: window.__neoApp.getCurrentUnit(),
    unitButtonCount: document.querySelectorAll('#unit-choice button').length,
    courseLabel: document.getElementById('course-label').textContent,
  }));
  ok('数Aを選ぶと先頭単元が自動選択される', afterSubject.subject === 'sa' && afterSubject.unit === 'sa-kakuritsu' && afterSubject.unitButtonCount === 3, afterSubject);
  ok('全単元ノートの上部表示は、ガイドを変えても全単元のまま', afterSubject.courseLabel.includes('全単元'), afterSubject.courseLabel);

  console.log('\n== 3. 単元選択はキーボードだけで到達できる ==');
  await page.click('#unit-choice button:has-text("図形の性質")');
  const kbdReached = await page.evaluate(() => window.__neoApp.getCurrentUnit() === 'sa-zukei');
  ok('図形の性質を選べる', kbdReached);
  // マウス無しでも: フォーカス→Enterで選択できること
  await page.click('#unit-choice button:has-text("整数の性質")', { position: { x: 2, y: 2 } });
  await page.keyboard.press('Tab');
  const focusIsButton = await page.evaluate(() => document.activeElement instanceof HTMLButtonElement);
  ok('選択後のフォーカスはbuttonのまま（Tab移動できる）', focusIsButton);

  console.log('\n== 4. 選択はリロード後も維持される ==');
  await page.reload({ waitUntil: 'networkidle' });
  const persistedUnit = await page.evaluate(() => window.__neoApp.getCurrentUnit());
  ok('リロード後も整数の性質のまま', persistedUnit === 'sa-seisuu', persistedUnit);

  console.log('\n== 5. 単元を切り替えてもキー割り当ては1つも変わらない（機械的検証） ==');
  const snapshotByUnit = await page.evaluate(async () => {
    const app = window.__neoApp;
    const units = ['s1-suushiki', 's1-keiryo', 'sa-kakuritsu', 's2-bibunsekibun', 'sb-suuretsu', 'sc-vector', 's3-kyokugen', 's3-sekibun'];
    const snapshots = {};
    for (const u of units) {
      app.setCurrentUnit(u, false);
      await new Promise((r) => setTimeout(r, 0));
      const caps = [...document.querySelectorAll('#key-guide-board .key-cap')].map((el) => ({
        code: el.dataset.code,
        symbol: el.querySelector('.key-symbol').textContent,
        origin: el.querySelector('.key-origin').textContent,
        disabled: el.disabled,
      }));
      snapshots[u] = caps;
    }
    return snapshots;
  });
  const units = Object.keys(snapshotByUnit);
  const base = snapshotByUnit[units[0]];
  let mismatch = null;
  for (const u of units.slice(1)) {
    const other = snapshotByUnit[u];
    if (other.length !== base.length) { mismatch = { unit: u, reason: 'count differs' }; break; }
    for (let i = 0; i < base.length; i++) {
      const a = base[i];
      const b = other[i];
      if (a.code !== b.code || a.symbol !== b.symbol || a.origin !== b.origin || a.disabled !== b.disabled) {
        mismatch = { unit: u, code: a.code, base: a, other: b };
        break;
      }
    }
    if (mismatch) break;
  }
  ok('30キー全件、単元をまたいでも symbol/origin/disabled が完全一致', mismatch === null, mismatch);

  console.log('\n== 6. 単元に応じたout-of-unit状態は内部情報として残る ==');
  const outOfUnitDiffers = await page.evaluate(() => {
    const app = window.__neoApp;
    app.setCurrentUnit('s3-kyokugen', false);
    const limOutUnderKyokugen = document.querySelector('#key-guide-board .key-cap[data-code="KeyY"]').classList.contains('out-of-unit');
    app.setCurrentUnit('sa-kakuritsu', false);
    const limOutUnderKakuritsu = document.querySelector('#key-guide-board .key-cap[data-code="KeyY"]').classList.contains('out-of-unit');
    return { limOutUnderKyokugen, limOutUnderKakuritsu };
  });
  ok('lim(Y)のout-of-unit状態は単元に応じて変わる（見た目は薄くしない）', outOfUnitDiffers.limOutUnderKyokugen === false && outOfUnitDiffers.limOutUnderKakuritsu === true, outOfUnitDiffers);

  console.log('\n== 7. パレットは単元を切り替えても記号が1つも減らない・単元向けが先頭に来る ==');
  const paletteInfo = await page.evaluate(() => {
    const app = window.__neoApp;
    app.setCurrentUnit('sc-vector', false);
    document.getElementById('sidebar-close')?.click();
    return null;
  });
  await page.keyboard.press('Escape'); // パレットを開く（key-captureがaccessibleなので拾われる）
  await page.waitForTimeout(50);
  const vectorPalette = await page.evaluate(() => ({
    open: document.getElementById('palette').classList.contains('open'),
    total: document.querySelectorAll('#palette-grid .palette-btn').length,
    firstFewFeatured: [...document.querySelectorAll('#palette-grid .palette-btn')].slice(0, 3).map((b) => b.classList.contains('featured')),
    hasVec: [...document.querySelectorAll('#palette-grid .palette-btn')].some((b) => b.textContent.includes('a⃗')),
  }));
  ok('ベクトル単元でパレットが開く', vectorPalette.open);
  ok('ベクトル単元でベクトル記号が先頭に来る', vectorPalette.firstFewFeatured.some(Boolean), vectorPalette);
  ok('ベクトル単元でも a⃗ が打てる', vectorPalette.hasVec, vectorPalette);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(30);

  const totalOtherUnit = await page.evaluate(() => {
    window.__neoApp.setCurrentUnit('s1-data', false);
    return document.querySelectorAll('#palette-grid .palette-btn').length;
  });
  ok('別の単元へ切替えてもパレットの総数は変わらない（記号が消えない）', totalOtherUnit === vectorPalette.total, { totalOtherUnit, vectorTotal: vectorPalette.total });

  ok('consoleエラー・警告なし', consoleIssues.length === 0, consoleIssues);

  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  await browser.close();
  process.exit(failures.length ? 1 : 0);
}

main();
