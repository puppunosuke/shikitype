import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:8891/spike/test.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(200);

const results = {};

// ---------- Item 2: build structure via API ----------
// (a) insert fraction, is caret placed in numerator via public executeCommand API (no raw keystrokes)?
results.item2_insertFraction = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  mf.value = '';
  mf.focus();
  const ok = mf.executeCommand(['insert', '\\frac{#0}{#0}', { insertionMode: 'replaceSelection', selectionMode: 'placeholder' }]);
  return { ok, value: mf.value, position: mf.position, selection: mf.selection };
});

// (b) open a superscript slot via API
results.item2_openSuperscript = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  mf.value = 'x';
  mf.focus();
  mf.position = mf.lastOffset ?? 1;
  const selBefore = mf.selection;
  const ok = mf.executeCommand('moveToSuperscript');
  return { ok, selBefore, selAfter: mf.selection, value: mf.value };
});

// (c) close current slot by one level and move caret out — is there such a command?
results.item2_closeSlot = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  mf.value = 'x^{2';
  mf.focus();
  mf.position = mf.lastOffset;
  const before = { pos: mf.position };
  // candidates from the command list
  const candidates = ['moveAfterParent', 'moveToOpposite', 'moveToNextPlaceholder'];
  const tried = candidates.map(cmd => {
    const p0 = mf.position;
    let ok = false, err = null;
    try { ok = mf.executeCommand(cmd); } catch (e) { err = String(e); }
    const p1 = mf.position;
    // reset for next candidate
    mf.value = 'x^{2';
    mf.position = mf.lastOffset;
    return { cmd, ok, err, posBefore: p0, posAfterAttempt: p1 };
  });
  return { before, tried };
});

// ---------- Item 3: caret slot introspection ----------
async function probeSlot(latex, keystrokes) {
  return p.evaluate(({ latex, keystrokes }) => {
    const mf = document.getElementById('mf1');
    mf.value = '';
    mf.focus();
    return { latex, keystrokes }; // placeholder, actual typing done from Playwright side below
  }, { latex, keystrokes });
}

async function typeAndProbe(label, keys) {
  await p.evaluate(() => { document.getElementById('mf1').value = ''; document.getElementById('mf1').focus(); });
  await p.waitForTimeout(80);
  await p.keyboard.type(keys);
  await p.waitForTimeout(120);
  const r = await p.evaluate(() => {
    const mf = document.getElementById('mf1');
    const pos = mf.position;
    let info;
    try { info = mf.getElementInfo(pos); } catch (e) { info = { err: String(e) }; }
    const caretEl = mf.shadowRoot.querySelector('.ML__caret, .ML__text-caret');
    const ancestorClasses = [];
    let el = caretEl;
    while (el && el !== mf.shadowRoot) {
      if (el.className) ancestorClasses.push(String(el.className));
      el = el.parentElement;
    }
    return { value: mf.value, pos, depth: info.depth, latexAtPos: info.latex, ancestorClasses };
  });
  results['item3_' + label] = r;
}

await typeAndProbe('numerator_mid_entry', '1/'); // caret should be in numerator right after '/'... actually '1/' completes numerator as 1, caret moves to denom
await typeAndProbe('after_slash_before_denominator_digit', 'x/'); // cursor should now be positioned to type denominator
await typeAndProbe('inside_superscript_after_caret', 'x^'); // caret should be inside empty superscript
await typeAndProbe('inside_superscript_with_digit', 'x^2');
await typeAndProbe('inside_subscript_with_digit', 'x_2');
await typeAndProbe('inside_paren_group', '(');

// sqrt / abs via direct API insert (raw "\sqrt" keystrokes open an autocomplete
// popup instead of committing, which is not representative — use insert() instead)
async function insertAndProbe(label, latexWithPlaceholder) {
  const r = await p.evaluate((latex) => {
    const mf = document.getElementById('mf1');
    mf.value = '';
    mf.focus();
    mf.executeCommand(['insert', latex, { insertionMode: 'replaceSelection', selectionMode: 'placeholder' }]);
    const pos = mf.position;
    let info;
    try { info = mf.getElementInfo(pos); } catch (e) { info = { err: String(e) }; }
    const caretEl = mf.shadowRoot.querySelector('.ML__caret, .ML__text-caret');
    const ancestorClasses = [];
    let el = caretEl;
    while (el && el !== mf.shadowRoot) {
      if (el.className) ancestorClasses.push(String(el.className));
      el = el.parentElement;
    }
    return { value: mf.value, pos, depth: info.depth, latexAtPos: info.latex, ancestorClasses };
  }, latexWithPlaceholder);
  results['item3_' + label] = r;
}
await insertAndProbe('inside_sqrt_via_api', '\\sqrt{#0}');
await insertAndProbe('inside_abs_via_api', '\\left|#0\\right|');

console.log(JSON.stringify(results, null, 2));
await b.close();
