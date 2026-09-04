// 段階3: ブロック単位のLaTeXコピー（最優先）と、ノート全体のLaTeX書き出し
// （クリップボードコピー／.texダウンロード）。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log('  OK  ' + label); }
  else { failures.push({ label, detail }); console.log('  FAIL ' + label + ': ' + JSON.stringify(detail)); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  // navigator.clipboard.writeText を使うため、コンテキストへ明示的に権限を与える。
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', (err) => failures.push({ label: 'pageerror', detail: err.message }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.notes.v1'));
  await page.reload({ waitUntil: 'networkidle' });

  // Windows側OSクリップボードは改行をCRLFへ正規化することがあるため、比較前にLFへ揃える。
  async function readClipboard() { return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'); }

  console.log('\n== 1. ブロック単位のLaTeXコピー（最優先要件） ==');
  await page.evaluate(() => { window.__neoApp.rows[0].mf.value = '\\frac{1}{2}x^2'; });
  await page.waitForTimeout(60);
  await page.click('.row-copy-latex');
  await page.waitForTimeout(60);
  const copied = await readClipboard();
  ok('行のTeXボタンでその式のLaTeXがクリップボードへコピーされる', copied === '\\frac{1}{2}x^2', copied);
  const feedback = await page.evaluate(() => document.querySelector('.row-copy-latex').textContent);
  ok('コピー後にボタンへ完了フィードバックが出る', feedback === '済', feedback);
  await page.waitForTimeout(1200);
  const restored = await page.evaluate(() => document.querySelector('.row-copy-latex').textContent);
  ok('フィードバックは一定時間で元の表示(TeX)へ戻る', restored === 'TeX', restored);

  console.log('\n== 2. 行モードでノート全体をLaTeXとしてコピー ==');
  await page.evaluate(() => window.__neoApp.newNote());
  await page.evaluate(() => { window.__neoApp.rows[0].mf.value = 'a+b'; });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(60);
  await page.evaluate(() => { window.__neoApp.rows[1].mf.value = 'c-d'; });
  await page.waitForTimeout(60);
  await page.click('#export-note-toggle');
  await page.waitForTimeout(30);
  ok('書き出しメニューが開く', await page.isVisible('#export-note-menu'));
  await page.click('#export-note-latex-copy');
  await page.waitForTimeout(60);
  const noteCopied = await readClipboard();
  ok('行の並び順どおりに\\[ ... \\]で書き出す', noteCopied === '\\[ a+b \\]\n\n\\[ c-d \\]', noteCopied);

  console.log('\n== 3. canvasモードでは配置ではなく読み順（上→下・左→右）で書き出す ==');
  await page.click('#sidebar-toggle');
  await page.click('.layout-mode-choice[data-layout-mode="canvas"]');
  await page.click('#sidebar-close');
  await page.waitForTimeout(60);
  // 意図的にx,yを入れ替えて配置し、書き出しは座標順(y優先)になることを確認する。
  await page.evaluate(() => {
    const [r0, r1] = window.__neoApp.rows;
    window.__neoApp.setLayoutMode('canvas');
    r0.mf.value = 'below';
    r1.mf.value = 'above';
  });
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    const [r0, r1] = window.__neoApp.rows;
    r0.wrap.dataset.canvasX = '400'; r0.wrap.dataset.canvasY = '500';
    r1.wrap.dataset.canvasX = '20'; r1.wrap.dataset.canvasY = '50';
  });
  // 仕様: サイドバー外をクリックすると書き出しメニューは閉じる。
  // 手順3の冒頭でサイドバーを開閉しており、その操作で書き出しメニューは閉じているため、
  // ここで再度メニューを開いてからコピー操作を行う。
  await page.click('#export-note-toggle');
  await page.waitForTimeout(30);
  ok('サイドバー操作の後は書き出しメニューが閉じており、再度開き直せる', await page.isVisible('#export-note-menu'));
  await page.click('#export-note-latex-copy');
  await page.waitForTimeout(60);
  const canvasCopied = await readClipboard();
  ok('yが小さい(上にある)ブロックが先に来る（座標は捨てて読み順だけ引き継ぐ）', canvasCopied === '\\[ above \\]\n\n\\[ below \\]', canvasCopied);

  console.log('\n== 4. ノート全体を.texファイルとしてダウンロード ==');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-note-latex-download'),
  ]);
  const suggested = download.suggestedFilename();
  ok('.tex拡張子でダウンロードされる', suggested.endsWith('.tex'), suggested);
  const streamPath = await download.path();
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(streamPath, 'utf8');
  ok('ダウンロードした中身もクリップボードと同じLaTeXテキスト', text === canvasCopied, { text, canvasCopied });

  ok('画面エラーなし', failures.filter((f) => f.label === 'pageerror').length === 0);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
