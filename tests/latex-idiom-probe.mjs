// うちが生成するLaTeXが、慣習どおりの書き方と見た目で一致するかを並べて確認する。
// 描画は同じエンジンなので、差が出れば「生成しているLaTeXが違う」ということ。
// 注意: heredocで作るとバックスラッシュが落ちる。必ずエディタから直接書くこと。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const CASES = [
  ['うち(修正前)   ', String.raw`\int\tan xdx`],
  ['うち(修正後)   ', String.raw`\int\tan x\,dx`],
  ['お手本 tan^3   ', String.raw`\int\tan^3x\,dx`],
  ['お手本 空白入り ', String.raw`\int \tan^3 x \, dx`],
];

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 900, height: 620 });
await p.goto('http://localhost:8893/app.html');
await p.waitForTimeout(900);

const round = await p.evaluate((cases) => {
  document.getElementById('key-guide')?.remove();
  const block = document.getElementById('block');
  block.innerHTML = '';
  const out = [];
  for (const [label, latex] of cases) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:18px;margin:8px 0;';
    const tag = document.createElement('code');
    tag.textContent = label;
    tag.style.cssText = 'font-size:11px;color:#888;width:130px;flex:none;white-space:pre;';
    const mf = document.createElement('math-field');
    mf.setAttribute('read-only', '');
    mf.style.fontSize = '40px';
    wrap.appendChild(tag);
    wrap.appendChild(mf);
    block.appendChild(wrap);
    mf.value = latex;
    out.push({ label, sent: latex, got: mf.value });
  }
  return out;
}, CASES);

for (const r of round) console.log(r.label, '| sent:', JSON.stringify(r.sent), '| got:', JSON.stringify(r.got));
await p.waitForTimeout(500);
await p.screenshot({ path: 'tests/out-latex-idiom.png', clip: { x: 0, y: 45, width: 700, height: 340 } });
console.log('screenshot: tests/out-latex-idiom.png');
await b.close();
