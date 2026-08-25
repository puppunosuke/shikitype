import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8891' });
await p.goto('http://localhost:8891/spike/test.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(200);

// does pasted "\int_0^1 x^2 dx" get parsed into real math atoms (mode=math, actual \int structure)
// or land as flat literal text?
const parseCheck = await p.evaluate(async () => {
  const mf = document.getElementById('mf1');
  mf.value = '';
  mf.focus();
  await navigator.clipboard.writeText('\\int_0^1 x^2 dx');
  return 'clip-set';
});
await p.keyboard.press('Control+v');
await p.waitForTimeout(150);
const parseResult = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  // if parsed as real math, there should be an atom with data indicating \int / integral,
  // and getElementInfo at various offsets should show mode 'math' and depth>0 for the "2" exponent etc.
  const html = mf.shadowRoot.querySelector('.ML__latex').innerHTML;
  const hasIntGlyph = html.includes('&#x222B;') || html.includes('∫') || /class="[^"]*int[^"]*"/i.test(html);
  const info0 = mf.getElementInfo(0);
  return { value: mf.value, hasIntGlyphInDom: hasIntGlyph, info0, snippet: html.slice(0, 500) };
});
console.log('PARSE_CHECK', JSON.stringify(parseResult, null, 2));

// garbage non-latex paste — is it parsed as text (verbatim) rather than structured math?
await p.evaluate(() => { document.getElementById('mf1').value = ''; document.getElementById('mf1').focus(); });
await p.waitForTimeout(80);
await p.evaluate(async () => { await navigator.clipboard.writeText('e^(iπ)+1=0'); });
await p.keyboard.press('Control+v');
await p.waitForTimeout(150);
const garbageResult = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  const info0 = mf.getElementInfo(0);
  const infoMid = mf.getElementInfo(3);
  return { value: mf.value, info0Mode: info0?.mode, infoMidMode: infoMid?.mode, lastOffset: mf.lastOffset };
});
console.log('GARBAGE_CHECK', JSON.stringify(garbageResult, null, 2));

// re-test focus across many instances with more wait + hasFocus()
const focus2 = await p.evaluate(async () => {
  const c = document.getElementById('many-container');
  c.innerHTML = '';
  for (let i = 0; i < 50; i++) {
    const mf = document.createElement('math-field');
    mf.value = 'x^{2}+\\frac{1}{n}';
    c.appendChild(mf);
  }
  await new Promise(r => setTimeout(r, 300));
  const fields = Array.from(c.querySelectorAll('math-field'));
  fields[0].focus();
  await new Promise(r => setTimeout(r, 100));
  const f0 = fields[0].hasFocus();
  fields[25].focus();
  await new Promise(r => setTimeout(r, 100));
  const f25 = fields[25].hasFocus();
  const f0After = fields[0].hasFocus();
  return { count: fields.length, f0, f25, f0StillFocusedAfterMovingAway: f0After };
});
console.log('FOCUS2', JSON.stringify(focus2, null, 2));

await b.close();
