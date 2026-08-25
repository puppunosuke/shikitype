// アプリの math-field に付けている default-mode 属性が ∫ の描画に効いているかを確かめる。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 900, height: 700 });
await p.goto('http://localhost:8893/app.html');
await p.waitForTimeout(800);

const result = await p.evaluate(() => {
  document.getElementById('key-guide')?.remove();
  const block = document.getElementById('block');
  block.innerHTML = '';
  const modes = ['(属性なし)', 'inline-math', 'math'];
  const out = [];
  for (const m of modes) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:18px;margin:6px 0;';
    const tag = document.createElement('code');
    tag.textContent = 'default-mode=' + m;
    tag.style.cssText = 'font-size:12px;color:#888;width:210px;flex:none;';
    const mf = document.createElement('math-field');
    mf.setAttribute('read-only', '');
    if (m !== '(属性なし)') mf.setAttribute('default-mode', m);
    mf.style.fontSize = '34px';
    wrap.appendChild(tag); wrap.appendChild(mf);
    block.appendChild(wrap);
    mf.value = String.raw`\int\tan xdx`;
    const box = mf.getBoundingClientRect();
    out.push({ mode: m, value: mf.value, h: Math.round(box.height) });
  }
  return out;
});

for (const r of result) console.log(String(r.mode).padEnd(14), 'h=' + r.h, JSON.stringify(r.value));
await p.waitForTimeout(400);
await p.screenshot({ path: 'tests/out-defaultmode.png', clip: { x: 0, y: 50, width: 760, height: 320 } });
console.log('screenshot: tests/out-defaultmode.png');
await b.close();
