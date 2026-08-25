// MathLive のフォントがアプリで実際に読めているかを確認する。
// ∫ が小さく沈んで見える原因が、Size系フォント不在によるフォールバックかを切り分ける。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const requests = [];
p.on('response', (r) => {
  const u = r.url();
  if (/\.(woff2?|ttf)(\?|$)/i.test(u)) requests.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), status: r.status() });
});
await p.goto('http://localhost:8893/app.html');
await p.waitForTimeout(1500);
await p.evaluate(() => {
  const mf = document.querySelector('math-field');
  mf.value = String.raw`\int\tan xdx`;
});
await p.waitForTimeout(1200);

console.log('--- font requests seen ---');
if (requests.length === 0) console.log('(なし = フォントを一度も取りに行っていない)');
for (const r of requests) console.log(r.status, r.url);

const loaded = await p.evaluate(async () => {
  const names = ['KaTeX_Size1', 'KaTeX_Size2', 'KaTeX_Main', 'KaTeX_Math'];
  const out = {};
  for (const n of names) out[n] = document.fonts.check(`34px ${n}`);
  return { checks: out, total: document.fonts.size };
});
console.log('--- document.fonts ---');
console.log(JSON.stringify(loaded, null, 1));
await b.close();
