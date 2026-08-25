// ∫ が実際にどのフォントで、どの実寸で描かれているかをDOMから直接読む。
// 注意: heredocで作るとバックスラッシュが落ちる。必ずエディタから直接書くこと。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const CASES = [
  ['inline', 'inline-math', String.raw`\int\tan xdx`],
  ['display', 'math', String.raw`\int\tan xdx`],
  ['displaystyle prefix', 'inline-math', String.raw`\displaystyle\int\tan xdx`],
];

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 900, height: 700 });
await p.goto('http://localhost:8893/app.html');
await p.waitForTimeout(900);

const out = await p.evaluate((cases) => {
  document.getElementById('key-guide')?.remove();
  const block = document.getElementById('block');
  block.innerHTML = '';
  const results = [];
  for (const [label, mode, latex] of cases) {
    const mf = document.createElement('math-field');
    mf.setAttribute('read-only', '');
    mf.setAttribute('default-mode', mode);
    mf.style.fontSize = '40px';
    block.appendChild(mf);
    mf.value = latex;

    const root = mf.shadowRoot;
    const leaves = root ? [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim()) : [];
    const items = leaves.map((e) => {
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        text: e.textContent.trim(),
        code: e.textContent.trim().codePointAt(0),
        font: cs.fontFamily.split(',')[0].replace(/"/g, ''),
        size: cs.fontSize,
        h: Math.round(r.height),
      };
    });
    results.push({ label, items: items.slice(0, 8) });
  }
  return results;
}, CASES);

for (const r of out) {
  console.log('=== ' + r.label);
  for (const i of r.items) {
    console.log('   ', JSON.stringify(i.text), 'U+' + i.code.toString(16).toUpperCase().padStart(4, '0'),
      'font=' + i.font, 'size=' + i.size, 'h=' + i.h);
  }
}
await b.close();
