// 空構造の共通削除、canvasの本文順/reflow、sidebar表面のdismissを実ブラウザで通す。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = process.env.NEO_BASE ?? 'http://localhost:8893/app.html';
let passed = 0; const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed += 1; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => { localStorage.clear(); window.__neoApp.newNote(); });
await page.reload({ waitUntil: 'networkidle' });

async function reset() {
  await page.evaluate(() => {
    window.__neoApp.newNote();
    const row = window.__neoApp.getActiveRow();
    row.mf.value = ''; row.mf.position = 0;
    row.stack = []; row.run = []; row.runStack = []; row.history = []; row.detachedFrames = [];
    row.inputProxy.focus();
  });
  await page.waitForTimeout(50);
}
async function press(key, count = 1) { for (let i = 0; i < count; i += 1) await page.keyboard.press(key); }
async function latex() { return page.evaluate(() => window.__neoApp.getActiveRow().mf.value); }

console.log('\n== empty structural contract ==');
for (const entry of [
  ['積分', { type: 'integral' }], ['分数', { type: 'nfrac' }], ['丸括弧', { type: 'open', kind: 'paren' }],
  ['根号', { type: 'open', kind: 'sqrt' }], ['絶対値', { type: 'open', kind: 'abs' }], ['総和', { type: 'sum' }],
]) {
  await reset();
  await page.evaluate((action) => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), action), entry[1]);
  await press('ArrowRight', 4);
  await press('Backspace');
  ok(`${entry[0]}は空のまま構造外へ出てもBackspace一回で丸ごと消える`, (await latex()) === '', await latex());
}
await reset();
await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  window.__neoApp.dispatchAction(row, { type: 'variable', letter: 'x' });
  window.__neoApp.dispatchAction(row, { type: 'open', kind: 'sup' });
});
await press('ArrowRight', 3); await press('Backspace');
ok('空の累乗は基底xを残して消える', (await latex()) === 'x', await latex());
await reset();
await page.evaluate(() => {
  const row = window.__neoApp.getActiveRow();
  window.__neoApp.dispatchAction(row, { type: 'variable', letter: 'x' });
  window.__neoApp.dispatchAction(row, { type: 'open', kind: 'sub' });
});
await press('ArrowRight', 3); await press('Backspace');
ok('空の下付きは基底xを残して消える', (await latex()) === 'x', await latex());
await reset();
await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'open', kind: 'paren' }));
await press('Enter'); await press('Backspace');
ok('Enterで閉じた空括弧も左右どちらも残さず消える', (await latex()) === '', await latex());
await reset();
await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'integral' }));
await page.evaluate(() => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), { type: 'digit', value: '0' }));
await press('ArrowRight', 4); await press('Backspace');
ok('中身のある積分も構造の外側なら一打で全消去する', await latex() === '', await latex());
for (const entry of [['括弧', { type: 'open', kind: 'paren' }], ['分数', { type: 'nfrac' }]]) {
  await reset(); await press('Enter');
  await page.evaluate((action) => window.__neoApp.dispatchAction(window.__neoApp.getActiveRow(), action), entry[1]);
  await press('ArrowUp'); await press('ArrowDown'); await press('ArrowRight', 4); await press('Backspace');
  ok(`${entry[0]}は別行への往復後も空なら丸ごと消える`, (await latex()) === '', await latex());
}

console.log('\n== canvas order and measured reflow ==');
await reset();
await press('Enter', 3);
await page.evaluate(() => {
  window.__neoApp.rows.forEach((row, index) => { row.mf.value = `r${index + 1}`; row.mf.position = row.mf.lastOffset; });
  window.__neoApp.setLayoutMode('canvas', false);
  window.__neoApp.rows[1].inputProxy.focus();
});
const beforeInsert = await page.evaluate(() => window.__neoApp.rows.map((row) => row.id));
await press('Enter'); await page.waitForTimeout(100);
const afterInsert = await page.evaluate(() => ({
  ids: window.__neoApp.rows.map((row) => row.id), values: window.__neoApp.rows.map((row) => row.mf.value),
  flow: window.__neoApp.rows.map((row) => row.canvasFlow),
}));
ok('canvasでも2行目Enterは新しい3行目を挿入し、旧3/4行目を後ろへ送る', afterInsert.ids.length === 5 && afterInsert.ids[0] === beforeInsert[0] && afterInsert.ids[1] === beforeInsert[1] && afterInsert.values[2] === '' && afterInsert.ids[3] === beforeInsert[2] && afterInsert.ids[4] === beforeInsert[3], afterInsert);
await page.evaluate(() => {
  const row = window.__neoApp.rows[1];
  row.mf.value = '\\dfrac{\\dfrac{1}{2}}{\\dfrac{3}{4}}';
  row.mf.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
});
await page.waitForTimeout(160);
const reflow = await page.evaluate(() => window.__neoApp.rows.map((row, index) => ({
  y: Number(row.wrap.dataset.canvasY), height: row.wrap.offsetHeight, width: row.wrap.offsetWidth,
  flow: row.canvasFlow, mathWidth: row.mf.scrollWidth, index,
})));
ok('縦長の数式後の自動配置blockは実寸+余白で重ならない', reflow.filter((row) => row.flow).every((row, index, all) => index === 0 || row.y >= all[index - 1].y + all[index - 1].height + 28), reflow);
await page.evaluate(() => {
  const row = window.__neoApp.rows[1];
  row.mf.value = Array.from({ length: 900 }, () => 'x').join('');
  row.mf.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
});
await page.waitForTimeout(160);
const wide = await page.evaluate(() => { const row = window.__neoApp.rows[1]; return { paper: row.wrap.offsetWidth, math: row.mf.scrollWidth }; });
ok('長式は紙面を実幅+操作余白まで伸ばし、1600pxで切らない', wide.paper >= wide.math + 60 && wide.paper > 1600, wide);
await page.evaluate(() => {
  const row = window.__neoApp.rows[1];
  row.inputProxy.focus();
});
await page.keyboard.press('KeyP'); await page.waitForTimeout(40);
await page.evaluate(() => {
  const row = window.__neoApp.rows[1];
  const rect = row.wrap.getBoundingClientRect();
  row.wrap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 91, button: 0, clientX: rect.left + 8, clientY: rect.top + 8 }));
  document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 91, clientX: rect.left + 108, clientY: rect.top + 72 }));
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 91, clientX: rect.left + 108, clientY: rect.top + 72 }));
});
await page.waitForTimeout(60);
const draggedCaret = await page.evaluate(() => {
  const row = window.__neoApp.rows[1]; const caret = row.caret.getBoundingClientRect(); const math = row.mf.getBoundingClientRect();
  return { caret: { left: caret.left, top: caret.top }, math: { left: math.left, right: math.right, top: math.top, bottom: math.bottom }, visible: !row.caret.hidden };
});
ok('canvas blockのdrag後も変換caretは移動先の数式blockへ追従する', draggedCaret.visible && draggedCaret.caret.left >= draggedCaret.math.left - 2 && draggedCaret.caret.left <= draggedCaret.math.right + 2 && draggedCaret.caret.top >= draggedCaret.math.top - 4 && draggedCaret.caret.top <= draggedCaret.math.bottom + 4, draggedCaret);

const draggedIsFree = await page.evaluate(() => window.__neoApp.rows[1].canvasFlow === false);
ok('drag済みblockはcanvasFlowがfalseになり自由配置扱いになる', draggedIsFree, draggedIsFree);
const beforeGrowPos = await page.evaluate(() => { const row = window.__neoApp.rows[1]; return { x: Number(row.wrap.dataset.canvasX), y: Number(row.wrap.dataset.canvasY) }; });
await page.evaluate(() => {
  const row = window.__neoApp.rows[1];
  row.mf.value = '\\dfrac{\\dfrac{1}{2}}{\\dfrac{3}{4}}' + Array.from({ length: 40 }, () => 'x').join('');
  row.mf.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
});
await page.waitForTimeout(160);
const afterGrowPos = await page.evaluate(() => { const row = window.__neoApp.rows[1]; return { x: Number(row.wrap.dataset.canvasX), y: Number(row.wrap.dataset.canvasY) }; });
ok('自由配置blockは内容が伸びてもx/yが動かない', afterGrowPos.x === beforeGrowPos.x && afterGrowPos.y === beforeGrowPos.y, { beforeGrowPos, afterGrowPos });

console.log('\n== canvasFlow survives note save/restore ==');
await page.evaluate(() => window.__neoApp.saveNote?.());
await page.waitForTimeout(80);
const beforeSave = await page.evaluate(() => window.__neoApp.rows.map((row) => ({ id: row.id, flow: row.canvasFlow === true, x: Number(row.wrap.dataset.canvasX), y: Number(row.wrap.dataset.canvasY) })));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(150);
const afterReload = await page.evaluate(() => window.__neoApp.rows.map((row) => ({ id: row.id, flow: row.canvasFlow === true, x: Number(row.wrap.dataset.canvasX), y: Number(row.wrap.dataset.canvasY) })));
ok('ノート復元後もcanvasFlowの真偽が行ごとに維持される', beforeSave.length === afterReload.length && beforeSave.every((row, i) => row.flow === afterReload[i].flow), { beforeSave, afterReload });
ok('ノート復元後も自由配置blockの座標がそのまま復元される', beforeSave.some((row) => !row.flow) && beforeSave.filter((row) => !row.flow).every((row) => { const restored = afterReload.find((r) => r.id === row.id); return restored && restored.x === row.x && restored.y === row.y; }), { beforeSave, afterReload });

console.log('\n== sidebar dismiss and modal backdrop ==');
await page.click('#notes-toggle'); await page.click('#course-label');
let dismiss = await page.evaluate(() => ({ hidden: document.getElementById('notes-list').hidden, expanded: document.getElementById('notes-toggle').getAttribute('aria-expanded') }));
ok('過去ノートは外側クリックで閉じ、aria-expandedも戻る', dismiss.hidden && dismiss.expanded === 'false', dismiss);
await page.click('#export-note-toggle'); await page.click('#course-label');
dismiss = await page.evaluate(() => ({ hidden: document.getElementById('export-note-menu').hidden, expanded: document.getElementById('export-note-toggle').getAttribute('aria-expanded') }));
ok('書き出しメニューも外側クリックで閉じる', dismiss.hidden && dismiss.expanded === 'false', dismiss);
await page.click('#new-note'); await page.evaluate(() => document.getElementById('new-note-dialog').dispatchEvent(new MouseEvent('click', { bubbles: true })));
ok('新規ノートdialogはbackdrop相当のdialog自身クリックで閉じる', !(await page.locator('#new-note-dialog').evaluate((dialog) => dialog.open)));

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
