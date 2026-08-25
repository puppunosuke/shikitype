// アプリを実際に打鍵して撮る（拓男が報告した式を再現する）。
// キャッシュの影響を排除するため、必ずキャッシュ無効で開く。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ bypassCSP: true });
const p = await ctx.newPage();
await p.route('**/*', (route) => route.continue());
await p.setViewportSize({ width: 760, height: 320 });
await p.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(900);

const K = async (...ks) => { for (const k of ks) await p.keyboard.press(k); };
const SH = async (k) => { await p.keyboard.down('Shift'); await p.keyboard.press(k); await p.keyboard.up('Shift'); };

// ∫ tan^3 x dx
await K('KeyU', 'KeyN', 'KeyD', 'Digit3', 'Space');
await SH('KeyX');
await K('KeyQ');

console.log('value:', await p.evaluate(() => document.querySelector('math-field').value));
const fontOk = await p.evaluate(() => document.fonts.check('40px KaTeX_Size1'));
console.log('KaTeX_Size1 loaded:', fontOk);
await p.screenshot({ path: 'tests/out-app-integral.png', clip: { x: 0, y: 45, width: 520, height: 150 } });
console.log('screenshot: tests/out-app-integral.png');
await b.close();
