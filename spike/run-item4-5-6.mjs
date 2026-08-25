import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8891' });
await p.goto('http://localhost:8891/spike/test.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(200);

const results = {};

// ---------- Item 4: unicode direct input ----------
async function unicodeProbe(label, unicodeStr) {
  await p.evaluate(() => { document.getElementById('mf1').value = ''; document.getElementById('mf1').focus(); });
  await p.waitForTimeout(80);
  await p.keyboard.insertText(unicodeStr); // simulates direct typing / IME commit of the literal char
  await p.waitForTimeout(120);
  const val = await p.evaluate(() => document.getElementById('mf1').value);
  results['item4_' + label] = { input: unicodeStr, valueAfter: val };
}
await unicodeProbe('integral', '∫');
await unicodeProbe('sigma', 'Σ');
await unicodeProbe('sqrt', '√');
await unicodeProbe('pi', 'π');
await unicodeProbe('leq', '≦');

// ---------- Item 5: LaTeX in/out + garbage paste ----------
results.item5_getSet = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  mf.value = '\\frac{1}{2}+\\sin(x)';
  const got = mf.getValue('latex');
  mf.value = ''; // clear
  mf.setValue(got);
  return { original: '\\frac{1}{2}+\\sin(x)', roundTrip: mf.value, match: mf.value === '\\frac{1}{2}+\\sin(x)' };
});

async function pasteProbe(label, text) {
  await p.evaluate(() => { document.getElementById('mf1').value = ''; document.getElementById('mf1').focus(); });
  await p.waitForTimeout(80);
  await p.evaluate(async (t) => { await navigator.clipboard.writeText(t); }, text);
  await p.keyboard.press('Control+v');
  await p.waitForTimeout(150);
  const val = await p.evaluate(() => document.getElementById('mf1').value);
  results['item5_paste_' + label] = { input: text, valueAfter: val };
}
await pasteProbe('nonlatex_math', 'e^(iπ)+1=0');
await pasteProbe('plain_latex', '\\int_0^1 x^2 dx');

// ---------- Item 6: many instances render cost ----------
async function buildCost(n) {
  const t = await p.evaluate((n) => window.buildInstances(n), n);
  return t;
}
results.item6_build_10ms = await buildCost(10);
results.item6_build_50ms = await buildCost(50);
// focus movement across instances (Tab)
const focusResult = await p.evaluate(async () => {
  const fields = Array.from(document.querySelectorAll('#many-container math-field'));
  fields[0].focus();
  await new Promise(r => setTimeout(r, 50));
  const activeBefore = document.activeElement === fields[0];
  return { count: fields.length, firstFocusWorked: activeBefore };
});
results.item6_focus = focusResult;

console.log(JSON.stringify(results, null, 2));
await b.close();
