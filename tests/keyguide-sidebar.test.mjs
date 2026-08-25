// キーガイド（物理キーボード表示）とサイドバー（キーマップコンフィグ）の検証。
// 見た目の主張ではなく、DOMとLaTeX出力を実測する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';

let pass = 0;
let fail = 0;
const failures = [];

function assertEqual(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  OK  ${label}`);
  } else {
    fail++;
    failures.push({ label, actual, expected });
    console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}

const capOf = (page, code) => page.evaluate((c) => {
  const el = document.querySelector(`#key-guide-board .key-cap[data-code="${c}"]`);
  if (!el) return null;
  return {
    symbol: el.querySelector('.key-symbol').textContent,
    origin: el.querySelector('.key-origin').textContent,
    classes: [...el.classList].filter((x) => x !== 'key-cap'),
  };
}, code);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.keymap-overrides.v2'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('.row math-field');

  console.log('\n== 1. キーキャップが物理配列で描かれる ==');
  const rowCount = await page.locator('#key-guide-board .key-row').count();
  assertEqual('3段ある', rowCount, 3);
  const capCount = await page.locator('#key-guide-board .key-cap').count();
  assertEqual('30キーすべて描く（単元外も間引かない）', capCount, 30);

  // 3段目まで実際に見えているか。max-heightで下段が切れると、ガイドが
  // 物理配列を写すという目的を果たさない（見えない段は無いのと同じ）。
  const rowsVisible = await page.evaluate(() => {
    const guide = document.querySelector('#key-guide').getBoundingClientRect();
    return [...document.querySelectorAll('#key-guide-board .key-row')]
      .every((r) => r.getBoundingClientRect().bottom <= guide.bottom + 1);
  });
  assertEqual('3段目まで切れずに見える', rowsVisible, true);

  console.log('\n== 2. 記号が大、元のキーが小 ==');
  assertEqual('U = ∫ / 添え字U', await capOf(page, 'KeyU'), { symbol: '∫', origin: 'U', classes: [] });
  assertEqual('F = (…)', (await capOf(page, 'KeyF')).symbol, '(…)');
  assertEqual('Semicolonの刻印は ;', (await capOf(page, 'Semicolon')).origin, ';');
  const sizes = await page.evaluate(() => {
    const cap = document.querySelector('#key-guide-board .key-cap[data-code="KeyU"]');
    return {
      symbol: parseFloat(getComputedStyle(cap.querySelector('.key-symbol')).fontSize),
      origin: parseFloat(getComputedStyle(cap.querySelector('.key-origin')).fontSize),
    };
  });
  assertEqual('記号のほうが元キーより大きい', sizes.symbol > sizes.origin, true);

  console.log('\n== 3. Tab循環とShift大文字化へガイドが追従する ==');
  await page.keyboard.press('Tab');
  assertEqual('Tab後: 英字・小文字', await page.textContent('#key-guide-layer'), '英字・小文字');
  assertEqual('英字層: U はu', (await capOf(page, 'KeyU')).symbol, 'u');
  await page.keyboard.down('Shift');
  assertEqual('Shift中: 英字・大文字', await page.textContent('#key-guide-layer'), '英字・大文字');
  assertEqual('Shift中: U はU', (await capOf(page, 'KeyU')).symbol, 'U');
  await page.keyboard.up('Shift');
  await page.keyboard.press('Tab');
  assertEqual('次のTab: ギリシャ・小文字', await page.textContent('#key-guide-layer'), 'ギリシャ・小文字');
  assertEqual('ギリシャ層: U はυ', (await capOf(page, 'KeyU')).symbol, 'υ');
  assertEqual('ギリシャ層の未割当Jは押せない', await page.isDisabled('#key-guide-board .key-cap[data-code="KeyJ"]'), true);
  await page.keyboard.down('Shift');
  assertEqual('Shift中: U はΥ', (await capOf(page, 'KeyU')).symbol, 'Υ');
  await page.keyboard.up('Shift');
  await page.keyboard.press('Tab');
  assertEqual('3回目のTabで記号へ戻る', await page.textContent('#key-guide-layer'), '記号');
  assertEqual('記号層: U は ∫', (await capOf(page, 'KeyU')).symbol, '∫');

  console.log('\n== 4. 押したキーが光る ==');
  await page.click('.row math-field');
  const flashed = await page.evaluate(async () => {
    const cap = document.querySelector('#key-guide-board .key-cap[data-code="KeyU"]');
    let seen = false;
    const obs = new MutationObserver(() => { if (cap.classList.contains('pressed')) seen = true; });
    obs.observe(cap, { attributes: true, attributeFilter: ['class'] });
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyU', bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    obs.disconnect();
    return seen;
  });
  assertEqual('打鍵でpressedが付く', flashed, true);

  console.log('\n== 5. サイドバーのキーマップ変更が実際の入力を変える ==');
  await page.reload({ waitUntil: 'networkidle' });
  // ノート自動保存後の再読込では直前の式が復元される。キー割り当ての出力だけを
  // 測るこの節は、意図的に白紙ノートから始める。
  await page.click('#new-note');
  await page.click('#sidebar-toggle');
  await page.click('[data-settings-category="keys"]');
  assertEqual('サイドバーが開く', await page.isVisible('#sidebar'), true);
  // modalは背景を操作不能にしつつviewport内へ収まる。drawerのように本文を押し出さない。
  const modalFit = await page.evaluate(() => {
    const side = document.querySelector('#sidebar').getBoundingClientRect();
    return document.getElementById('sidebar').open && side.left >= 0 && side.top >= 0 && side.right <= innerWidth && side.bottom <= innerHeight;
  });
  assertEqual('設定modalがviewport内に収まる', modalFit, true);

  // サイドバー内のキー一覧が右端で切れていないこと
  const keysFit = await page.evaluate(() => {
    const side = document.querySelector('#sidebar').getBoundingClientRect();
    return [...document.querySelectorAll('#config-keys .key-cap')]
      .every((c) => c.getBoundingClientRect().right <= side.right - 15);
  });
  assertEqual('設定側のキーが右端で切れない', keysFit, true);

  const statsPreserved = await page.evaluate(() => document.querySelector('#stats').textContent.includes('打鍵') && document.querySelector('#stats').getBoundingClientRect().width > 0);
  assertEqual('背景の統計は閉じた後も同じ位置で読める', statsPreserved, true);

  await page.click('#config-keys .key-cap[data-code="KeyT"]');
  assertEqual('割り当て欄が出る', await page.isVisible('#assign-section'), true);
  await page.click('#assign-grid .assign-btn:has-text("√")');
  assertEqual('ガイドのTが√になる', (await capOf(page, 'KeyT')).symbol, '√');
  assertEqual('変更済みの印が付く', (await capOf(page, 'KeyT')).classes.includes('customized'), true);

  await page.click('#sidebar-close');
  await page.click('.row math-field');
  await page.keyboard.press('KeyT');
  await page.keyboard.press('Digit9');
  const latex = await page.evaluate(() => window.__neoApp.getActiveRow().mf.getValue());
  assertEqual('Tを押すと√が入る（差し替えが入力へ効く）', latex, '\\sqrt9');

  console.log('\n== 6. 変更が再読み込み後も残る ==');
  await page.reload({ waitUntil: 'networkidle' });
  assertEqual('リロード後もTは√', (await capOf(page, 'KeyT')).symbol, '√');

  console.log('\n== 7. 叩き台へ戻せる ==');
  await page.click('#sidebar-toggle');
  await page.click('[data-settings-category="keys"]');
  await page.click('#reset-all');
  assertEqual('Tがセンタードットへ戻る', (await capOf(page, 'KeyT')).symbol, '·');
  assertEqual('変更数の表示', await page.textContent('#override-count'), '叩き台のまま（変更なし）');
  await page.reload({ waitUntil: 'networkidle' });
  assertEqual('リロードしても戻ったまま', (await capOf(page, 'KeyT')).symbol, '·');

  await page.screenshot({ path: 'tests/out-keyguide.png', fullPage: true });
  await page.click('#sidebar-toggle');
  await page.screenshot({ path: 'tests/out-keyguide-sidebar.png', fullPage: true });

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  await browser.close();
  process.exit(fail ? 1 : 0);
}

main();
