import { chromium } from 'playwright';

const headless = process.env.HEADFUL ? false : true;
const vivaldiPath = process.env.VIVALDI_PATH;
let b;
try {
  const opts = { headless };
  if (vivaldiPath) opts.executablePath = vivaldiPath;
  b = await chromium.launch(opts);
} catch (e) {
  console.log('LAUNCH_FAILED', String(e));
  b = await chromium.launch({ headless: true });
  console.log('FELL_BACK_TO_HEADLESS_DEFAULT_CHROMIUM');
}
console.log('BROWSER_VERSION', b.version());
const p = await b.newPage();
await p.goto('http://localhost:8891/spike/test.html');
await p.waitForFunction(() => window.__ready === true);
await p.waitForTimeout(200);

await p.click('#alt-target');
await p.evaluate(() => window.clearLog());

const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
const results = {};
for (const ch of letters) {
  await p.evaluate(() => window.clearLog());
  await p.keyboard.down('Alt');
  await p.keyboard.press(ch.toUpperCase());
  await p.keyboard.up('Alt');
  await p.waitForTimeout(30);
  const log = await p.evaluate(() => window.getLog());
  const letterKeydown = log.find(e => e.tag === 'alt-target' && e.alt === true && e.key.toLowerCase() === ch);
  const reached = !!letterKeydown;
  results[ch] = { reached, logEntries: log.length, letterEvent: letterKeydown || null, fullLog: log };
}

const failures = Object.entries(results).filter(([k, v]) => !v.reached).map(([k]) => k);
console.log('MODE', headless ? 'headless' : 'headful');
console.log('FAILURES', JSON.stringify(failures));
console.log('FULL', JSON.stringify(results, null, 2));

await b.close();
