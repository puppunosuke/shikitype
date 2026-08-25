// MathLive と KaTeX の描画を同じLaTeXで並べて撮る。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1100, height: 1000 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://localhost:8893/tests/renderer-compare.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(1200);
const katexRendered = await p.evaluate(() => document.querySelectorAll('.katex').length);
console.log('katex nodes rendered:', katexRendered);
console.log('page errors:', errs.length ? errs : 'none');
await p.screenshot({ path: 'tests/out-renderer-compare.png', fullPage: true });
console.log('screenshot: tests/out-renderer-compare.png');
await b.close();
