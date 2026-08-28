// SHIKITYPE変換方式: OS IMEを数式から外し、raw英字を層ごとの候補集合へ送る回帰。
import { chromium } from '../spike/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
const failures = []; let passed = 0;
function ok(label, value, detail = value) { if (value) { passed += 1; console.log(`  OK  ${label}`); } else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); } }
await page.goto('http://localhost:8893/app.html', { waitUntil: 'networkidle' });
await page.evaluate(() => { localStorage.clear(); window.__neoApp.setInputSystem('conversion', false); });
await page.reload({ waitUntil: 'networkidle' });
async function reset(layer = 'symbol') {
  await page.evaluate((wanted) => { const row = window.__neoApp.getActiveRow(); row.mf.value = ''; row.mf.executeCommand(['switchMode', 'math']); row.mf.position = 0; row.stack = []; row.run = []; row.runStack = []; row.history = []; row.nativeTextOpen = false; Object.assign(row.conversion, { raw: '', reading: '', searchReading: '', pending: '', navigation: false, selectedIndex: 0 }); row.conversion.preview.textContent = ''; row.conversion.preview.hidden = true; window.__neoApp.setInputSystem('conversion', false); for (let guard = 0; window.__neoApp.getBaseLayer() !== wanted && guard < 4; guard += 1) window.__neoApp.cycleBaseLayer(false); row.inputProxy.focus(); }, layer);
  // MathLiveの直前の直接入力から残るfocus/rAFを落ち着かせてから、専用proxyを検証する。
  await page.waitForTimeout(80);
}
async function conversion() { return page.evaluate(() => window.__neoApp.getConversionState()); }
async function value() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }
async function typeRaw(text) {
  for (const char of text.toUpperCase()) await page.keyboard.press(char === '-' ? 'Minus' : `Key${char}`);
}
console.log('\n== 変換層だけの専用IME・途中候補 ==');
await reset('symbol'); await typeRaw('x'); let state = await conversion(); ok('変換層のx一打は小文字xを絶対先頭候補にする', state.raw === 'x' && state.candidates[0] === 'latin-lower-x', state); await page.keyboard.press('Enter'); ok('x → Enterで小文字xを確定する', await value() === 'x', await value());
await reset('symbol'); await typeRaw('p'); state = await conversion(); ok('p一打でも小文字pを先頭にし、πより優先する', state.candidates[0] === 'latin-lower-p' && state.candidates.includes('pi'), state); await page.keyboard.press('Enter'); ok('p → Enterでπではなく小文字pを確定する', await value() === 'p', await value());
await reset('symbol'); await typeRaw('p');
const synchronousOwner = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  const event = new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', bubbles: true, cancelable: true });
  row.inputProxy.dispatchEvent(event);
  return { raw: row.conversion.raw, owner: row.conversion.shell.dataset.ownerRow, rowId: row.id };
});
ok('行モードは位置追従rAF前でも候補trayのowner rowを設定する', synchronousOwner.raw === 'pp' && synchronousOwner.owner === synchronousOwner.rowId, synchronousOwner);
let trayGeometry = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  const tray = row.conversion.shell.getBoundingClientRect(); const sheet = document.getElementById('editor-sheet').getBoundingClientRect();
  return { tray, sheet, belowCaret: tray.top >= row.caret.getBoundingClientRect().bottom - 1, owner: row.conversion.shell.dataset.ownerRow === row.id };
});
ok('行モードの候補トレイはcaret直下かつ編集面の左右内に収まる', trayGeometry.belowCaret && trayGeometry.owner && trayGeometry.tray.left >= trayGeometry.sheet.left + 5 && trayGeometry.tray.right <= trayGeometry.sheet.right - 5, trayGeometry);
await page.setViewportSize({ width: 360, height: 780 }); await page.waitForTimeout(80);
trayGeometry = await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow(); const tray = row.conversion.shell.getBoundingClientRect(); const sheet = document.getElementById('editor-sheet').getBoundingClientRect();
  return { tray, sheet, belowCaret: tray.top >= row.caret.getBoundingClientRect().bottom - 1, owner: row.conversion.shell.dataset.ownerRow === row.id };
});
ok('360px行モードでも候補トレイは編集面の左右にclipしない', trayGeometry.belowCaret && trayGeometry.owner && trayGeometry.tray.left >= trayGeometry.sheet.left + 5 && trayGeometry.tray.right <= trayGeometry.sheet.right - 5, trayGeometry);
await page.setViewportSize({ width: 1180, height: 780 }); await page.waitForTimeout(50);
await reset('symbol'); await typeRaw('pai'); state = await conversion(); ok('変換層のpaiはπ候補を出す', state.candidates[0] === 'pi', state); await page.keyboard.press('Enter'); ok('変換層のpai → Enterでπを確定する', (await value()).includes('\\pi'), await value());
await reset('symbol'); await typeRaw('pa-sento'); state = await conversion(); ok('pa-sentoは入力途中から%候補を保持する', state.candidates.includes('percent'), state); await page.keyboard.press('Enter'); ok('pa-sento → Enterで%を確定する', (await value()).includes('\\%'), await value());
await reset('symbol'); await typeRaw('integral'); state = await conversion(); ok('変換層のintegralは∫候補を出す', state.candidates.includes('integral') && state.raw === 'integral', state); await page.keyboard.press('Enter'); ok('変換層の∫を確定する', (await value()).includes('\\int'), await value());
await reset('symbol'); await typeRaw('lim'); state = await conversion(); ok('変換層のlimはlim候補を出す', state.candidates.includes('limit'), state);
for (const raw of ['g', 'gu', 'tegu']) { await reset('symbol'); await typeRaw(raw); state = await conversion(); ok(`${raw}は積分の語中一致で候補を出さない`, !state.candidates.includes('integral'), state); }
for (const raw of ['i', 'in', 'inte', 'integral', 's', 'seki', 'sekibun']) { await reset('symbol'); await typeRaw(raw); state = await conversion(); ok(`${raw}は積分aliasの語頭として候補を出す`, state.candidates.includes('integral'), state); }
await reset('greek'); await typeRaw('p'); state = await conversion(); ok('ギリシャ層では変換候補を出さない', !state.open && state.raw === '', state); ok('ギリシャ層のPキーは直接πを入力する', (await value()).includes('\\pi'), await value());
await reset('symbol'); const proxyFocus = await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); return { proxy: document.activeElement === row.inputProxy, math: document.activeElement === row.mf }; }); ok('通常数式は非編集proxyへfocusを置きMathLiveへ置かない', proxyFocus.proxy && !proxyFocus.math, proxyFocus);
await page.evaluate(() => { const proxy = window.__neoApp.getActiveRow().inputProxy; for (const letter of 'INTEGRAL') proxy.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: `Key${letter}`, key: 'Process', keyCode: 229 })); }); await page.waitForTimeout(40); state = await conversion(); const processResult = await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); return { preview: row.conversion.preview.textContent, visible: [...row.conversion.list.querySelectorAll('.conversion-candidate')].map((node) => node.textContent), proxy: document.activeElement === row.inputProxy }; }); ok('日本語IME相当Processキーもcode由来英字integralとして∫候補を出す', state.raw === 'integral' && processResult.preview === 'integral' && processResult.visible.includes('∫') && processResult.proxy, { state, processResult });
const noCompositionLeak = await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); const before = row.mf.value; row.mf.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true })); row.mf.value = `${before}いんてぐらる`; row.mf.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true, data: 'いんてぐらる' })); return { value: row.mf.value, raw: row.conversion.raw, proxy: document.activeElement === row.inputProxy }; }); ok('proxy中のcomposition文字は数式にもrawにも混入しない', noCompositionLeak.value === '' && noCompositionLeak.raw === 'integral' && noCompositionLeak.proxy, noCompositionLeak);
await reset('symbol'); await page.click('[data-special="Text"]'); await page.waitForTimeout(20); let textState = await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); return { native: row.nativeTextOpen, focused: document.activeElement === row.mf || row.mf.contains(document.activeElement) }; }); ok('文キー内だけはMathLiveへfocusして標準IMEを許可する', textState.native && textState.focused, textState); await page.keyboard.type('hello'); await page.keyboard.press('Enter'); await page.waitForTimeout(150); textState = await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); return { native: row.nativeTextOpen, proxy: document.activeElement === row.inputProxy, value: row.mf.value }; }); ok('文内physical Enterは文を閉じ、次行を作らずproxyへ戻る', !textState.native && textState.proxy && textState.value.includes('\\text{hello}'), textState); await page.click('[data-special="Text"]'); await page.click('[data-special="Enter"]'); await page.waitForTimeout(150); textState = await page.evaluate(() => { const row = window.__neoApp.getActiveRow(); return { native: row.nativeTextOpen, proxy: document.activeElement === row.inputProxy }; }); ok('文内画面Enterも文を閉じてproxyへ戻る', !textState.native && textState.proxy, textState);
await browser.close(); console.log(`\n${passed} passed, ${failures.length} failed`); if (failures.length) process.exitCode = 1;
