// 変換候補を確定した後のBackspaceは、読みへ戻さず確定済みの数式を削除する回帰。
// 読みを直したいときは確定前にBackspaceを使う。確定後に毎回再変換へ戻ると、
// 普通の数式編集（例: tanを消す）が一手増えるため廃止した。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => { localStorage.clear(); window.__neoApp.setInputSystem('conversion', false); });
await page.reload({ waitUntil: 'networkidle' });

async function reset() {
  await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    row.mf.value = ''; row.mf.executeCommand(['switchMode', 'math']); row.mf.position = 0;
    row.stack = []; row.run = []; row.runStack = []; row.history = []; row.nativeTextOpen = false;
    Object.assign(row.conversion, { raw: '', reading: '', searchReading: '', pending: '', navigation: false, selectedIndex: 0 });
    row.conversion.preview.textContent = ''; row.conversion.preview.hidden = true;
    window.__neoApp.setInputSystem('conversion', false);
    while (window.__neoApp.getBaseLayer() !== 'symbol') window.__neoApp.cycleBaseLayer(false);
    row.inputProxy.focus();
  });
  await page.waitForTimeout(30);
}
async function typeRaw(text) { for (const char of text.toUpperCase()) await page.keyboard.press(`Key${char}`); }
async function value() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
async function conversion() { return page.evaluate(() => window.__neoApp.getConversionState()); }

console.log('\n== 確定候補のBackspaceは通常の数式削除 ==');
await reset();
await typeRaw('tannjento');
let state = await conversion();
ok('tannjentoもtan候補へ届く', state.candidates.includes('tan'), state);
await page.keyboard.press('Enter');
ok('tan候補が確定する', (await value()).includes('\\tan'), await value());
await page.keyboard.press('Backspace');
state = await conversion();
ok('tan確定直後のBackspaceは読みを復元せずtan全体を消す', (await value()) === '' && state.raw === '' && !state.candidates.length, { latex: await value(), state });

await reset();
await typeRaw('integral');
await page.keyboard.press('Enter');
ok('積分候補が構造として確定する', (await value()).includes('\\int'), await value());
await page.keyboard.press('Backspace');
state = await conversion();
ok('構造候補でもBackspaceは再変換せず構造を削除する', (await value()) === '' && state.raw === '' && !state.candidates.length, { latex: await value(), state });

ok('画面エラーなし', errors.length === 0, errors);
await browser.close();
console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) process.exit(1);
