// ∫ の描画比較プローブ（インライン/ディスプレイ × 上下限の置き方）
// 注意: シェルのheredoc経由でスクリプトを作るとバックスラッシュが1段落ちて
// 別物のLaTeXを測ってしまう。このファイルは必ずエディタから直接書くこと。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const CASES = [
  ['inline  int tan x dx', 'inline-math', String.raw`\int\tan xdx`],
  ['display int tan x dx', 'math', String.raw`\int\tan xdx`],
  ['inline  int_0^1', 'inline-math', String.raw`\int_0^1x^2dx`],
  ['display int_0^1', 'math', String.raw`\int_0^1x^2dx`],
  ['display int nolimits', 'math', String.raw`\int\nolimits_0^1x^2dx`],
  ['display displaystyle-in-inline', 'inline-math', String.raw`{\displaystyle\int}_0^1x^2dx`],
];

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 900, height: 900 });
await p.goto('http://localhost:8893/app.html');
await p.waitForTimeout(800);

const measured = await p.evaluate((cases) => {
  document.getElementById('key-guide')?.remove();
  const block = document.getElementById('block');
  block.innerHTML = '';
  const out = [];
  for (const [label, mode, latex] of cases) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:18px;margin:4px 0;';
    const tag = document.createElement('code');
    tag.textContent = label;
    tag.style.cssText = 'font-size:11px;color:#888;width:230px;flex:none;';
    const mf = document.createElement('math-field');
    mf.setAttribute('read-only', '');
    mf.setAttribute('default-mode', mode);
    mf.style.fontSize = '34px';
    wrap.appendChild(tag);
    wrap.appendChild(mf);
    block.appendChild(wrap);
    mf.value = latex;
    out.push({ label, latexRoundTrip: mf.value });
  }
  return out;
}, CASES);

await p.waitForTimeout(400);
for (const m of measured) console.log(m.label.padEnd(32), '->', JSON.stringify(m.latexRoundTrip));
await p.screenshot({ path: 'tests/out-integral-compare.png', clip: { x: 0, y: 40, width: 800, height: 700 } });
console.log('screenshot: tests/out-integral-compare.png');
await b.close();
