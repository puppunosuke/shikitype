// ∫ の垂直位置と前後アキの確認。
// 「∫ が沈んで見える／後ろが空きすぎ」の原因がフォントサイズ由来か、
// MathLive の演算子間スペース由来かを切り分ける。
// 注意: heredoc経由で作るとバックスラッシュが落ちる。必ずエディタから直接書くこと。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const CASES = [
  ['22px  int tan x dx', 22, String.raw`\int\tan xdx`],
  ['34px  int tan x dx', 34, String.raw`\int\tan xdx`],
  ['34px  int tan x \\,dx', 34, String.raw`\int\tan x\,dx`],
  ['34px  int f(x) dx', 34, String.raw`\int f(x)dx`],
  ['34px  int x^2 dx', 34, String.raw`\int x^2dx`],
  ['34px  sqrt for compare', 34, String.raw`\sqrt{x}+\tan x`],
];

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 900, height: 900 });
await p.goto('http://localhost:8893/app.html');
await p.waitForTimeout(800);

await p.evaluate((cases) => {
  document.getElementById('key-guide')?.remove();
  const block = document.getElementById('block');
  block.innerHTML = '';
  for (const [label, size, latex] of cases) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:18px;margin:2px 0;';
    const tag = document.createElement('code');
    tag.textContent = label;
    tag.style.cssText = 'font-size:11px;color:#888;width:190px;flex:none;';
    const cell = document.createElement('div');
    // ベースラインの基準線を引く: 文字の下端がここに揃うのが正しい
    cell.style.cssText = 'border-bottom:1px solid #f00; display:inline-block;';
    const mf = document.createElement('math-field');
    mf.setAttribute('read-only', '');
    mf.style.fontSize = size + 'px';
    cell.appendChild(mf);
    wrap.appendChild(tag);
    wrap.appendChild(cell);
    block.appendChild(wrap);
    mf.value = latex;
  }
}, CASES);

await p.waitForTimeout(400);
await p.screenshot({ path: 'tests/out-integral-align.png', clip: { x: 0, y: 40, width: 780, height: 640 } });
console.log('screenshot: tests/out-integral-align.png');
await b.close();
