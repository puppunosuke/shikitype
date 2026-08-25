// ∫ の実寸を MathLive と KaTeX で数値比較する。主観で「小さい気がする」を終わらせる。
// 同じ font-size で同じ LaTeX を描き、描画ボックスの高さを測る。
// 注意: heredocで作るとバックスラッシュが落ちる。必ずエディタから直接書くこと。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 900, height: 600 });
await p.goto('http://localhost:8893/tests/renderer-compare.html');
await p.waitForFunction(() => window.__ready === true);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(1200);

const r = await p.evaluate(async () => {
  await document.fonts.ready;
  const host = document.body;
  const mk = (tag) => { const d = document.createElement(tag); host.appendChild(d); return d; };

  // MathLive
  const mf = document.createElement('math-field');
  mf.setAttribute('read-only', '');
  mf.style.fontSize = '40px';
  host.appendChild(mf);
  mf.value = String.raw`\int`;
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const mlContent = mf.shadowRoot.querySelector('[part=content]');
  const mlH = mlContent.getBoundingClientRect().height;

  // KaTeX
  const kd = mk('div');
  kd.style.fontSize = '40px';
  katex.render(String.raw`\int`, kd, { throwOnError: false, displayMode: true });
  const kEl = kd.querySelector('.katex');
  const kH = kEl.getBoundingClientRect().height;

  return {
    fontsLoaded: {
      Size1: document.fonts.check('40px KaTeX_Size1'),
      Size2: document.fonts.check('40px KaTeX_Size2'),
      Main: document.fonts.check('40px KaTeX_Main'),
    },
    mathliveIntHeight: Math.round(mlH),
    katexIntHeight: Math.round(kH),
  };
});

console.log(JSON.stringify(r, null, 1));
await b.close();
