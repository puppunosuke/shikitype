// NEO Math Solution — Pass 1 入力コア 検証スイート（A2E5）
// 実DOMをPlaywrightで駆動し、実際のLaTeX値をassertする。「動いた気がする」を許さない。
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
  await page.click('math-field');
  await page.waitForTimeout(100);

  async function pressCode(code, mods = {}) {
    const held = [];
    if (mods.shift) { await page.keyboard.down('Shift'); held.push('Shift'); }
    if (mods.alt) { await page.keyboard.down('Alt'); held.push('Alt'); }
    if (mods.ctrl) { await page.keyboard.down('Control'); held.push('Control'); }
    await page.keyboard.press(code);
    for (const m of held.reverse()) await page.keyboard.up(m);
    await page.waitForTimeout(15);
  }

  async function seq(items) {
    for (const it of items) {
      if (typeof it === 'string') await pressCode(it);
      else await pressCode(it.code, it);
    }
  }

  async function latex() {
    return page.evaluate(() => document.querySelector('.row:last-child math-field').value);
  }

  async function rowState() {
    return page.evaluate(() => {
      const rows = window.__neoApp.rows;
      const row = rows[rows.length - 1];
      return { latex: row.mf.value, stackDepth: row.stack.length, stackKinds: row.stack.map((f) => f.kind) };
    });
  }

  async function resetLastRow() {
    await page.evaluate(() => {
      while (window.__neoApp.getBaseLayer() !== 'symbol') window.__neoApp.cycleBaseLayer();
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

  async function visibleSlotContext() {
    return page.evaluate(() => {
      const contexts = [...document.querySelectorAll('.slot-context')];
      return contexts.filter((item) => !item.hidden).map((item) => item.textContent);
    });
  }

  async function switchLayer(layer) {
    let guard = 0;
    while (await page.evaluate(() => window.__neoApp.getBaseLayer()) !== layer && guard++ < 3) {
      await pressCode('Tab');
    }
  }

  // ---------------------------------------------------------------
  console.log('\n== 1. term system: () / n-alpha / alpha-n / ^ / _ / sqrt / abs ==');

  await resetLastRow();
  assertEqual('root: slot context stays fully hidden', await visibleSlotContext(), []);
  await pressCode('KeyF');
  assertEqual('paren: slot context follows the active block only while open', await visibleSlotContext(), ['括弧内']);
  await seq(['Digit1', 'Space']); // ( 1 space-close
  assertEqual('paren: (1) closes correctly', await latex(), '\\left(1\\right)');
  assertEqual('root: slot context disappears after closing', await visibleSlotContext(), []);

  await resetLastRow();
  await seq(['KeyL', 'Digit1', 'Space', 'Digit2', 'Space']); // n/alpha: 1/2
  assertEqual('n/alpha: 1/2', await latex(), '\\dfrac12');

  await resetLastRow();
  await seq(['Digit3', 'KeyJ', 'Digit4', 'Space']); // 3 then alpha/n -> 3/4
  // MathLive serializes single-digit num/den compactly as \dfrac34 (mathematically identical to \dfrac{3}{4})
  assertEqual('alpha/n: 3/4 (previous digit term becomes numerator)', await latex(), '\\dfrac34');

  await resetLastRow();
  await switchLayer('latin'); await seq(['KeyX']); await switchLayer('symbol');
  await seq(['KeyD', 'Digit2', 'Space']); // x^2
  assertEqual('superscript: x^2', await latex(), 'x^2');

  await resetLastRow();
  await switchLayer('latin'); await seq(['KeyX']); await switchLayer('symbol');
  await seq(['KeyK', 'Digit1', 'Space']); // x_1
  assertEqual('subscript: x_1', await latex(), 'x_1');

  await resetLastRow();
  await seq(['KeyA', Div('Digit9'), 'Space']); // sqrt(9)
  assertEqual('sqrt: √9', await latex(), '\\sqrt9');

  // 2026-08-30 拓男指定でSemicolon→絶対値の割り当ては撤去した（音声指摘2件目）。
  // 絶対値そのもの（'abs'スロット）は生きているので、実際に使う経路
  // （サイドバーのキー再割当・変換方式の読み「ぜったいち」）と同じdispatchActionで検証する。
  await resetLastRow();
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    window.__neoApp.dispatchAction(row, { type: 'open', kind: 'abs' });
  });
  await seq([Div('KeyH'), 'Digit5', 'Space']); // |-5|  (KeyH = '-')
  assertEqual('abs: |-5|', await latex(), '\\left|-5\\right|');

  // ---------------------------------------------------------------
  console.log('\n== 2. space = close exactly one level (nested), N presses close N levels ==');

  await resetLastRow();
  await seq(['KeyF']); // (
  let s = await rowState();
  assertEqual('nest step0: depth after (', s.stackDepth, 1);

  await seq(['KeyL']); // n/alpha inside paren
  s = await rowState();
  assertEqual('nest step1: depth after ( + n/alpha', s.stackDepth, 2);
  assertEqual('nest step1: kinds', s.stackKinds, ['paren', 'nfrac']);

  await seq(['Digit1', 'Space', 'Digit2']); // numerator 1, space->den, denom 2
  s = await rowState();
  assertEqual('nest step2: still depth 2 while in denominator', s.stackDepth, 2);
  assertEqual('nest step2: latex mid-nest', s.latex, '\\left(\\dfrac12\\right)');

  await seq(['Space']); // close fraction: depth 2 -> 1
  s = await rowState();
  assertEqual('nest step3: 1st space closes fraction only (depth 2->1)', s.stackDepth, 1);
  assertEqual('nest step3: kinds after 1st close', s.stackKinds, ['paren']);
  assertEqual('nest step3: latex unchanged by close (caret-only move)', s.latex, '\\left(\\dfrac12\\right)');

  await seq(['Space']); // close paren: depth 1 -> 0
  s = await rowState();
  assertEqual('nest step4: 2nd space closes paren (depth 1->0)', s.stackDepth, 0);

  await seq(['Space']); // nothing open: no-op
  s = await rowState();
  assertEqual('nest step5: 3rd space with nothing open is a no-op', s.stackDepth, 0);
  assertEqual('nest step5: latex unchanged by no-op space', s.latex, '\\left(\\dfrac12\\right)');

  // ---------------------------------------------------------------
  console.log('\n== 3. Shift+Space reopens exactly one level ==');

  await resetLastRow();
  await seq(['KeyA', 'Digit4']); // sqrt(4), still open
  s = await rowState();
  assertEqual('reopen setup: sqrt open, depth 1', s.stackDepth, 1);
  await seq(['Space']); // close
  s = await rowState();
  assertEqual('reopen: closed, depth 0', s.stackDepth, 0);
  await seq([{ code: 'Space', shift: true }]); // reopen
  s = await rowState();
  assertEqual('reopen: Shift+Space restores depth 1', s.stackDepth, 1);
  assertEqual('reopen: kinds restored', s.stackKinds, ['sqrt']);

  await resetLastRow();
  await seq(['KeyA', 'Digit4', 'Space']);
  await page.click('[data-modifier="shift"]');
  await seq(['Space']);
  assertEqual('画面Shift→物理Spaceでも1段開き直す', (await rowState()).stackDepth, 1);

  // ---------------------------------------------------------------
  console.log('\n== 4. previous-term ("直前の項") 4 patterns feeding alpha/n numerator ==');

  // pattern 1: closed bracket group as a whole
  await resetLastRow();
  await seq(['KeyF', Div('Digit1'), 'KeyG', 'Digit2', 'Space']); // (1+2) closed
  await seq(['KeyJ', 'Digit9', 'Space']); // alpha/n on the whole group
  assertEqual('pattern1 (closed group): frac{(1+2)}{9}', await latex(), '\\dfrac{\\left(1+2\\right)}{9}');

  // pattern 2: digit run
  await resetLastRow();
  await seq(['Digit1', 'Digit2', 'Digit3']); // 123
  await seq(['KeyJ', 'Digit4', 'Space']); // alpha/n -> 123/4
  assertEqual('pattern2 (digit run): frac{123}{4}', await latex(), '\\dfrac{123}{4}');

  // pattern 3: variable + attached sup/sub, nothing between
  await resetLastRow();
  await switchLayer('latin'); await seq(['KeyA']); await switchLayer('symbol'); await seq(['KeyK']);
  await switchLayer('latin'); await seq(['KeyN']); await switchLayer('symbol'); await seq(['Space']); // a_n
  await seq(['KeyJ']); await switchLayer('latin'); await seq(['KeyM']); await switchLayer('symbol'); await seq(['Space']);
  // MathLive keeps braces around the single-char subscript when re-serialized: a_{n} (identical meaning to a_n)
  assertEqual('pattern3 (var+script): frac{a_n}{m}', await latex(), '\\dfrac{a_{n}}{m}');

  // pattern 4: function application (sin x)
  await resetLastRow();
  await seq(['KeyV']); await switchLayer('latin'); await seq(['KeyX']); await switchLayer('symbol'); // sin x
  await seq(['KeyJ', Div('Digit2'), 'Space']); // alpha/n -> (sin x)/2
  assertEqual('pattern4 (func app): frac{\\sin x}{2}', await latex(), '\\dfrac{\\sin x}{2}');

  // does NOT cross + - =
  await resetLastRow();
  await seq(['Digit1', 'KeyG', 'Digit2', 'Digit3']); // 1+23
  await seq(['KeyJ', Div('Digit9'), 'Space']); // alpha/n should take only "23", not "1+23"
  assertEqual('boundary: term stops at "+" (takes 23 not 1+23)', await latex(), '1+\\dfrac{23}{9}');

  // ---------------------------------------------------------------
  console.log('\n== 5. Tabで英字層、Shiftで大文字（sample across rows） ==');

  const sampleKeys = ['KeyA', 'KeyF', 'KeyJ', 'KeyM', 'KeyQ', 'KeyV', 'KeyZ'];
  for (const code of sampleKeys) {
    await resetLastRow();
    await switchLayer('latin');
    await seq([code]);
    const lower = await latex();
    await resetLastRow();
    await switchLayer('latin');
    await seq([{ code, shift: true }]);
    const upper = await latex();
    const letter = code.replace('Key', '');
    assertEqual(`英字層 ${letter} -> lowercase`, lower, letter.toLowerCase());
    assertEqual(`英字層 Shift+${letter} -> uppercase`, upper, letter.toUpperCase());
  }

  await resetLastRow();
  await switchLayer('greek');
  await seq(['KeyA', { code: 'KeyG', shift: true }]);
  assertEqual('ギリシャ層: α + Shift+G -> Γ', await latex(), '\\alpha\\Gamma');

  await resetLastRow();
  await switchLayer('latin');
  await seq([{ code: 'KeyA', alt: true }]);
  assertEqual('Altはレイヤー機能を持たず英字層のaのまま', await latex(), 'a');

  // ---------------------------------------------------------------
  console.log('\n== 6. lim (n->infty) and Sigma (k=1->n) ==');

  await resetLastRow();
  await seq(['KeyY']); await switchLayer('latin'); await seq(['KeyN']); await switchLayer('symbol');
  await seq(['KeyR', 'Slash', 'Space']);
  assertEqual('lim n->infty', await latex(), '\\lim_{n\\to\\infty}');

  await resetLastRow();
  await seq(['KeyO']); await switchLayer('latin'); await seq(['KeyK']); await switchLayer('symbol');
  await seq(['KeyS', 'Digit1', 'Space']); await switchLayer('latin'); await seq(['KeyN']); await switchLayer('symbol'); await seq(['Space']);
  assertEqual('sum k=1 -> n', await latex(), '\\sum_{k=1}^{n}');

  // ---------------------------------------------------------------
  // Note: this only proves the compositionstart/compositionend guard fires and rolls back the
  // value when a composition is synthetically dispatched (same method 3F7B used, since Playwright
  // cannot drive a real OS IME). It does NOT prove suppression against real Windows IME.
  console.log('\n== 6b. IME composition guard (synthetic dispatch, matches 3F7B method) ==');
  await resetLastRow();
  await seq(['Digit1']); // baseline content: "1"
  const imeResult = await page.evaluate(() => {
    const rows = window.__neoApp.rows;
    const mf = rows[rows.length - 1].mf;
    const before = mf.value;
    mf.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }));
    mf.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, composed: true, data: 'あ' }));
    // simulate IME committing text into the field directly (what 3F7B found bypasses keydown)
    mf.value = before + 'あ';
    mf.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: 'あ' }));
    return { before, afterGuard: mf.value };
  });
  assertEqual('IME guard: composed text is rolled back to pre-composition value', imeResult.afterGuard, imeResult.before);

  // ---------------------------------------------------------------
  console.log('\n== 7. Enter creates a new row (vertical stacking) ==');

  const rowCountBefore = await page.evaluate(() => window.__neoApp.rows.length);
  await pressCode('Enter');
  await page.waitForTimeout(150);
  const rowCountAfter = await page.evaluate(() => window.__neoApp.rows.length);
  assertEqual('Enter appends a new row', rowCountAfter, rowCountBefore + 1);

  // ---------------------------------------------------------------
  console.log('\n== 8. keystroke/time logging exists ==');
  const statsSnapshot = await page.evaluate(() => ({ keystrokes: window.__neoStats.keystrokes, hasStart: typeof window.__neoStats.startTime === 'number' }));
  assertEqual('keystroke counter increments (> 0)', statsSnapshot.keystrokes > 0, true);
  assertEqual('session start time recorded', statsSnapshot.hasStart, true);

  // ---------------------------------------------------------------
  console.log('\n== 9. Tab layer cycle ==');
  await resetLastRow();
  const cycle = [];
  for (let i = 0; i < 4; i++) {
    cycle.push(await page.evaluate(() => window.__neoApp.getBaseLayer()));
    if (i < 3) await pressCode('Tab');
  }
  assertEqual('Tab cycles symbol -> latin -> greek -> symbol', cycle, ['symbol', 'latin', 'greek', 'symbol']);

  // ---------------------------------------------------------------
  console.log('\n== 9b. palette (Esc) opens and inserts a symbol ==');
  await resetLastRow();
  await pressCode('Escape');
  const paletteOpen = await page.evaluate(() => document.getElementById('palette').classList.contains('open'));
  assertEqual('Escape opens the palette', paletteOpen, true);
  await page.click('#palette-grid .palette-btn'); // first item = alpha
  const afterPaletteClick = await latex();
  // palette entries carry a trailing space (LaTeX command boundary) which round-trips literally
  assertEqual('clicking a palette symbol inserts its LaTeX (alpha)', afterPaletteClick, '\\alpha ');
  const paletteClosedAfterClick = await page.evaluate(() => document.getElementById('palette').classList.contains('open'));
  assertEqual('palette closes after picking a symbol', paletteClosedAfterClick, false);

  // ---------------------------------------------------------------
  console.log('\n== 10. self-consistency: no MathLive depth mismatch warnings observed ==');
  // =========================================================================
  // 11. Backspace（3規則）
  // 追加理由: 未実装だったものを後から入れたため。特に規則3（構造ごと取り消し）は
  // 「押し間違えを1打で戻せる」がキーなので、実LaTeXで戻り切ることを見る。
  // =========================================================================
  console.log('\n== 11. Backspace ==');
  await resetLastRow();
  await pressCode('Digit1'); await pressCode('Digit2');
  await pressCode('Backspace');
  assertEqual('rule1: deletes one atom', await latex(), '1');

  await resetLastRow();
  await pressCode('Digit5');
  await pressCode('KeyL');                       // n/α を誤爆
  await pressCode('Backspace');
  assertEqual('rule3: an empty structure is undone whole', await latex(), '5');
  assertEqual('rule3: stack popped', (await rowState()).stackDepth, 0);

  await resetLastRow();
  await pressCode('KeyL'); await pressCode('Digit3'); await pressCode('Space'); // 分母へ
  await pressCode('Backspace');
  assertEqual('rule2: empty later slot steps back to the previous slot',
    (await rowState()).stackKinds, ['nfrac']);
  assertEqual('rule2: back in the numerator', await page.textContent('.slot-context:not([hidden])'), '分子');

  // =========================================================================
  // 12. 矢印キー
  // =========================================================================
  console.log('\n== 12. arrow keys ==');
  await resetLastRow();
  await pressCode('Digit1'); await pressCode('Digit2'); await pressCode('Digit3');
  await pressCode('ArrowLeft'); await pressCode('ArrowLeft');
  await pressCode('Digit9');
  assertEqual('left/right: inserts at the moved caret', await latex(), '1923');

  await resetLastRow();
  await pressCode('KeyF'); await pressCode('Digit1');
  assertEqual('arrow: inside the paren before moving', (await rowState()).stackDepth, 1);
  await pressCode('ArrowRight');
  assertEqual('arrow: leaving the structure pops our stack', (await rowState()).stackDepth, 0);

  // =========================================================================
  // 13. Enter は開いているスロットを閉じてから行を変える
  // 追加理由: 既存テストが「行が増えたか」しか見ておらず、
  // フォーカスが前の行に残る不具合を通してしまっていた。
  // =========================================================================
  console.log('\n== 13. Enter closes slots and moves focus ==');
  await resetLastRow();
  await pressCode('KeyF'); await pressCode('Digit1');   // "(1" 開いたまま
  await pressCode('Enter');
  await pressCode('Digit2');
  const afterEnter = await page.evaluate(() => [...document.querySelectorAll('math-field')].map((m) => m.value));
  assertEqual('Enter: typing lands on the NEW row, not the old one',
    afterEnter[afterEnter.length - 1], '2');
  assertEqual('Enter: the previous row got closed', afterEnter[afterEnter.length - 2], '\\left(1\\right)');
  assertEqual('Enter: no slots left open', (await rowState()).stackDepth, 0);

  assertEqual('no [stack-mismatch] warnings logged during the whole run', consoleWarnings.filter((w) => w.includes('stack-mismatch')), []);

  await browser.close();

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('\nFailed cases:');
    for (const f of failures) console.log(' -', f.label);
    process.exitCode = 1;
  }
}

// helper: press a code but with no delay bundling issue — just an alias for readability in test sequences
function Div(code) { return code; }

main();
