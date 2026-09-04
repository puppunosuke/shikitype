// NEO Math Solution — 2026-08-23 修正の回帰テスト
// 対象: Backspace安全化 / 経過時間の常時更新 / キー操作モード（accessible・original）
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';

let pass = 0;
let fail = 0;
const failures = [];

function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  OK  ${label}`);
  } else {
    fail++;
    failures.push({ label, actual, expected });
    console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleWarnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning' && /neo-math/.test(msg.text())) consoleWarnings.push(msg.text());
  });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  await page.goto(BASE);
  await page.waitForSelector('math-field');
  await page.waitForTimeout(300);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('math-field');
  await page.waitForTimeout(300);
  await page.click('math-field');
  await page.waitForTimeout(100);

  async function pressCode(code, mods = {}) {
    const held = [];
    if (mods.shift) { await page.keyboard.down('Shift'); held.push('Shift'); }
    if (mods.ctrl) { await page.keyboard.down('Control'); held.push('Control'); }
    await page.keyboard.press(code);
    for (const m of held.reverse()) await page.keyboard.up(m);
    await page.waitForTimeout(15);
  }

  async function latex() {
    return page.evaluate(() => {
      const rows = window.__neoApp.rows;
      return rows[rows.length - 1].mf.value;
    });
  }

  async function rowState() {
    return page.evaluate(() => {
      const rows = window.__neoApp.rows;
      const row = rows[rows.length - 1];
      return { latex: row.mf.value, stackDepth: row.stack.length };
    });
  }

  // 変換方式（既定）ではbaseLayerが常に'symbol'に固定されており、cycleBaseLayer()を
  // 呼んでも'latin'へは絶対に遷移しない（app.jsのcycleBaseLayer実装を確認済み）。
  // 旧来の複数入力方式（layer切替式）が前提だった頃の後始末なので、到達不能な条件で
  // 待ち続けるwhileループを組まない。resetLastRowはsymbolのままで何もする必要がない。
  async function dispatchOnLastRow(action) {
    await page.evaluate((a) => {
      const rows = window.__neoApp.rows;
      const row = rows[rows.length - 1];
      window.__neoApp.dispatchAction(row, a);
    }, action);
    await page.waitForTimeout(15);
  }

  // 変換方式では物理英字キーは常に変換の読みバッファへ入り、Enterで先頭候補
  // （単独英字ならその文字自身）を確定して初めて式へ literal として入る。
  async function typeLiteralOnLastRow(letters) {
    for (const ch of letters) {
      await pressCode('Key' + ch.toUpperCase());
      await pressCode('Enter');
    }
  }

  async function resetLastRow() {
    await page.evaluate(() => {
      const rows = window.__neoApp.rows;
      const row = rows[rows.length - 1];
      row.mf.value = '';
      row.stack = [];
      row.run = [];
      row.history = [];
      row.runStack = [];
      row.mf.focus();
    });
    await page.waitForTimeout(60);
  }

  // =========================================================================
  // 1. Backspace安全化: 矢印移動後も式全体が消えない
  // =========================================================================
  console.log('\n== 1. backspace safety after arrow movement ==');

  await resetLastRow();
  // KeyF（'('）は変換方式では読みバッファに入るだけで構造を開けないため、
  // 括弧オープンはKeyU（∫）と同じ理由でdispatchActionを直接呼ぶ。
  await dispatchOnLastRow({ type: 'open', kind: 'paren' });
  await typeLiteralOnLastRow('xyz');
  await pressCode('ArrowRight');                 // 構造の外へ出る
  assertEqual('setup: (xyz) after arrow out', await latex(), '\\left(xyz\\right)');
  await pressCode('Backspace');                  // 旧実装では式全体が消えた
  const afterArrowBs = await latex();
  assertEqual('arrow-out + Backspace keeps the structure', afterArrowBs.startsWith('\\left('), true);
  console.log('      [probe] after arrow-out Backspace:', JSON.stringify(afterArrowBs));
  // 構造が壊れず（式全体が消えず）、かつ1文字だけ減っていること
  assertEqual('arrow-out + Backspace deletes ONE char only (structure kept)',
    afterArrowBs.length < '\\left(xyz\\right)'.length && afterArrowBs.includes('xyz'), true);

  await resetLastRow();
  await dispatchOnLastRow({ type: 'open', kind: 'paren' });
  await typeLiteralOnLastRow('xyz');
  await pressCode('ArrowLeft');                  // 構造の中へ入り直す
  await pressCode('Backspace');
  const afterInBs = await latex();
  assertEqual('arrow-in + Backspace deletes one char inside (not whole)',
    afterInBs === '\\left(xy\\right)' || afterInBs === '\\left(xz\\right)', true);

  // 分数分母での演算子入力→Backspace
  await resetLastRow();
  // KeyL（n/α）・KeyG（+）も同様に、変換方式では読みバッファへ入るだけで
  // 直接その記号にはならない。構造・演算子とも直接dispatchで作る。
  await dispatchOnLastRow({ type: 'nfrac' });    // n/α
  await pressCode('Digit1');
  await pressCode('Enter');                      // 分母へ
  await dispatchOnLastRow({ type: 'op', symbol: '+' });
  const denBefore = await latex();
  assertEqual('setup: fraction with + in denominator', denBefore, '\\dfrac{1}{+}');
  await pressCode('Backspace');
  const denAfter = await latex();
  console.log('      [probe] after 1st Backspace:', JSON.stringify(denAfter));
  assertEqual('fraction denominator + then Backspace removes only "+" (structure kept)',
    denAfter.includes('\\dfrac') && !denAfter.includes('+'), true);
  // 2回目のBackspaceで分母の分数構造が消える（規則2相当）
  await pressCode('Backspace');
  const denAfter2 = await latex();
  assertEqual('second Backspace in empty denominator steps back (structure kept or removed cleanly)',
    denAfter2 === '\\dfrac{1}{}' || denAfter2 === '\\dfrac1' || denAfter2 === '1', true);

  // 通常文末の1アトム削除は従来どおり
  await resetLastRow();
  await pressCode('Digit1'); await pressCode('Digit2');
  await pressCode('Backspace');
  assertEqual('plain end-of-text Backspace still deletes one atom', await latex(), '1');

  // =========================================================================
  // 2. 経過時間が打鍵なしでも進む
  // =========================================================================
  console.log('\n== 2. elapsed time keeps ticking without keystrokes ==');

  const t0 = await page.textContent('#stat-elapsed');
  await page.waitForTimeout(1300);
  const t1 = await page.textContent('#stat-elapsed');
  assertEqual('elapsed advances without any keystroke', parseFloat(t1) > parseFloat(t0), true);

  // =========================================================================
  // 3. キー操作モード: accessible では F2/F4/F8/F9、original では無効
  // =========================================================================
  console.log('\n== 3. key capture mode ==');

  assertEqual('default mode is accessible', await page.evaluate(() => window.__neoApp.getKeyCaptureMode()), 'accessible');

  // F2で設定サイドバーが開き、フォーカスが設定内へ移る
  await page.click('math-field');
  await pressCode('F2');
  let sidebarOpen = await page.evaluate(() => document.getElementById('sidebar').open);
  assertEqual('F2 opens settings sidebar', sidebarOpen, true);
  const focusInSidebar = await page.evaluate(() => !!document.activeElement?.closest('#sidebar'));
  assertEqual('focus moves into sidebar on F2 open', focusInSidebar, true);

  // F4でキーガイド折りたたみ（Escはパレット開閉なので使わない）
  sidebarOpen = await page.evaluate(() => document.getElementById('sidebar').open);
  if (sidebarOpen) {
    await page.click('#sidebar-close');
  }
  await page.click('math-field');
  const guideCollapsedBefore = await page.evaluate(() => document.getElementById('key-guide').classList.contains('collapsed'));
  await pressCode('F4');
  const guideCollapsedAfter = await page.evaluate(() => document.getElementById('key-guide').classList.contains('collapsed'));
  assertEqual('F4 toggles key guide collapse', guideCollapsedAfter, !guideCollapsedBefore);
  await pressCode('F4');                         // 戻しておく

  // F8/F9でテーマが動く
  const theme0 = await page.evaluate(() => window.__neoApp.getTheme());
  await page.click('math-field');
  await pressCode('F9');
  const theme1 = await page.evaluate(() => window.__neoApp.getTheme());
  assertEqual('F9 cycles theme forward', theme1 !== theme0, true);
  await pressCode('F8');
  const theme2 = await page.evaluate(() => window.__neoApp.getTheme());
  assertEqual('F8 cycles theme backward (back to original)', theme2, theme0);

  // original モードでは F2 が効かない（旧動作）
  await page.evaluate(() => window.__neoApp.setKeyCaptureMode('original'));
  await page.click('math-field');
  await pressCode('F2');
  sidebarOpen = await page.evaluate(() => document.getElementById('sidebar').open);
  assertEqual('original mode ignores F2', sidebarOpen, false);

  // サイドバーから元に戻せる（ユーザー要望: 元のバージョンもサイドバーから選べる）
  await page.evaluate(() => { document.getElementById('sidebar-toggle').click(); });
  const choices = await page.$$eval('#capture-choice button', (btns) => btns.map((b) => b.textContent));
  assertEqual('capture mode choices exist in sidebar', choices.length, 2);
  await page.click('#capture-choice button:nth-child(2)');   // 数式優先（旧動作）を選択中のはず
  const pressedLabel = await page.$eval('#capture-choice button.active', (b) => b.textContent);
  assertEqual('original selectable from sidebar and marked active', pressedLabel, '数式優先（旧動作）');

  // accessible へ戻して保存確認
  await page.click('#capture-choice button:nth-child(1)');
  assertEqual('switching back to accessible works', await page.evaluate(() => window.__neoApp.getKeyCaptureMode()), 'accessible');
  const persisted = await page.evaluate(() => localStorage.getItem('neo-math.key-capture.v1'));
  assertEqual('mode persists to localStorage', persisted, 'accessible');

  // リロード後も保持
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  assertEqual('mode survives reload', await page.evaluate(() => window.__neoApp.getKeyCaptureMode()), 'accessible');

  // =========================================================================
  // 4. 全体整合: stack-mismatch が出ていないこと
  // =========================================================================
  console.log('\n== 4. consistency ==');
  assertEqual('no [stack-mismatch] warnings during the whole run',
    consoleWarnings.filter((w) => w.includes('stack-mismatch')), []);

  await browser.close();

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('\nFailed cases:');
    for (const f of failures) console.log(' -', f.label);
    process.exitCode = 1;
  }
}

main();
