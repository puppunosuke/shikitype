import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:8891/spike/test.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(300);

async function dump(label) {
  const r = await p.evaluate(() => {
    const mf = document.getElementById('mf1');
    const pos = mf.position;
    let info;
    try { info = mf.getElementInfo(pos); } catch (e) { info = { err: String(e) }; }
    const caretEl = mf.shadowRoot.querySelector('.ML__caret, .ML__text-caret');
    let caretAncestors = [];
    let el = caretEl;
    while (el && el !== mf.shadowRoot) {
      caretAncestors.push(el.className || el.tagName);
      el = el.parentElement;
    }
    return { value: mf.value, pos, info, caretAncestors };
  });
  console.log(label, JSON.stringify(r));
}

await p.evaluate(() => document.getElementById('mf1').focus());
await p.waitForTimeout(100);
const focused = await p.evaluate(() => {
  const mf = document.getElementById('mf1');
  return { hasFocus: mf.hasFocus(), active: document.activeElement.tagName, shadowActive: mf.shadowRoot.activeElement ? mf.shadowRoot.activeElement.className : null };
});
console.log('focus check', focused);
await p.keyboard.type('1/2');
await dump('after 1/2 typed');

async function reset() {
  await p.evaluate(() => { document.getElementById('mf1').value = ''; });
  await p.evaluate(() => document.getElementById('mf1').focus());
  await p.waitForTimeout(150);
}

await reset();
await p.keyboard.type('x^2');
await p.waitForTimeout(150);
await dump('after x^2 typed');

await reset();
await p.keyboard.type('x_2');
await p.waitForTimeout(150);
await dump('after x_2 typed (subscript)');

await b.close();
