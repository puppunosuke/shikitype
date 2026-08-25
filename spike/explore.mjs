import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on('console', (m) => console.log('[console]', m.text()));
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:8891/spike/test.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(300);

const info = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  return {
    tag: mf.tagName,
    ctor: mf.constructor.name,
    hasShadow: !!mf.shadowRoot,
    methods: Object.getOwnPropertyNames(Object.getPrototypeOf(mf)).filter(n => {
      try { return typeof mf[n] === 'function'; } catch { return false; }
    }).slice(0, 200),
  };
});
console.log(JSON.stringify(info, null, 2));

// build a fraction and inspect
const struct = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  mf.value = '';
  mf.focus();
  mf.executeCommand(['insert', '\\frac{}{}', { insertionMode: 'replaceSelection' }]);
  const pos1 = mf.position;
  const info1 = mf.getElementInfo(pos1);
  const shadowHtml = mf.shadowRoot ? mf.shadowRoot.innerHTML.slice(0, 4000) : null;
  return { pos1, info1, shadowHtmlLen: mf.shadowRoot ? mf.shadowRoot.innerHTML.length : 0, shadowHtml };
});
console.log('STRUCT', JSON.stringify(struct, null, 2));

await b.close();
