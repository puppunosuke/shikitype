import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:8891/spike/test.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(200);

const r = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  mf.value = 'x';
  mf.focus();
  mf.position = 1;
  mf.executeCommand('moveToSuperscript'); // enter empty superscript, mirrors our "open slot" op
  mf.insert('2', { insertionMode: 'insertAfter' });
  const insideState = { value: mf.value, pos: mf.position, depth: mf.getElementInfo(mf.position)?.depth };
  const ok = mf.executeCommand('moveAfterParent'); // candidate for "close slot, move caret out"
  const afterState = { value: mf.value, pos: mf.position, depth: mf.getElementInfo(mf.position)?.depth };
  return { insideState, moveAfterParentOk: ok, afterState };
});
console.log(JSON.stringify(r, null, 2));

// nested case: fraction inside a paren group, close innermost (denominator) only
const r2 = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  mf.value = '';
  mf.focus();
  mf.executeCommand(['insert', '\\left(a+\\frac{#0}{#0}\\right)', { insertionMode: 'replaceSelection', selectionMode: 'placeholder' }]);
  const numeratorState = { value: mf.value, pos: mf.position, depth: mf.getElementInfo(mf.position)?.depth };
  mf.executeCommand('moveToNextChar'); // move from numerator into denominator like real usage might
  const afterMove = { value: mf.value, pos: mf.position, depth: mf.getElementInfo(mf.position)?.depth };
  const ok = mf.executeCommand('moveAfterParent'); // should close ONLY the fraction, not the outer paren
  const closedOnce = { value: mf.value, pos: mf.position, depth: mf.getElementInfo(mf.position)?.depth };
  const ok2 = mf.executeCommand('moveAfterParent'); // should close the paren next
  const closedTwice = { value: mf.value, pos: mf.position, depth: mf.getElementInfo(mf.position)?.depth };
  return { numeratorState, afterMove, closedOnce, closedTwice, ok, ok2 };
});
console.log(JSON.stringify(r2, null, 2));

await b.close();
