// AI見直しのUIは通常の数式IMEと同じdocument keydownを共有する。見た目だけでなく、
// dialog内のTab/Escape・初期hidden・ブロックIDの保存をブラウザで固定する回帰テスト。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed += 1; console.log('  OK  ' + label); }
  else { failures.push({ label, detail }); console.log('  FAIL ' + label + ': ' + JSON.stringify(detail)); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 980, height: 820 } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.notes.v1'));
  await page.reload({ waitUntil: 'networkidle' });

  await page.click('math-field');
  await page.keyboard.press('KeyX');
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyY');
  await page.waitForTimeout(520);
  const first = await page.evaluate(() => window.__neoApp.getNotes().notes[0]?.layout?.blockIds);
  ok('行ごとのIDを保存する', Array.isArray(first) && first.length === 2 && new Set(first).size === 2, first);

  await page.reload({ waitUntil: 'networkidle' });
  const restored = await page.evaluate(() => window.__neoApp.getNotes().notes[0]?.layout?.blockIds);
  ok('再読み込み後もブロックIDを維持する', JSON.stringify(restored) === JSON.stringify(first), { first, restored });

  await page.click('#review-toggle');
  const initial = await page.evaluate(() => ({
    dialogOpen: document.getElementById('review-dialog').open,
    resultHidden: document.getElementById('review-result').hidden,
    resultDisplay: getComputedStyle(document.getElementById('review-result')).display,
    loginVisible: !document.getElementById('review-login').hidden,
  }));
  ok('見直し結果面は初期表示で完全に隠れる', initial.dialogOpen && initial.resultHidden && initial.resultDisplay === 'none', initial);
  ok('未ログイン時はログイン導線を出す', initial.loginVisible, initial);

  await page.focus('#review-dialog-close');
  await page.keyboard.press('Shift+Tab');
  ok('Shift+Tabは見直しモーダル内を循環する', await page.evaluate(() => document.activeElement?.id === 'review-submit'));
  await page.keyboard.press('Tab');
  ok('Tabは見直しモーダル内を循環する', await page.evaluate(() => document.activeElement?.id === 'review-dialog-close'));
  await page.focus('#review-problem');
  await page.keyboard.type('x');
  ok('見直しモーダル内の文字入力を数式IMEへ漏らさない', await page.inputValue('#review-problem') === 'x');
  await page.fill('#review-problem', 'xを求めよ');
  await page.click('#review-login');
  const transfer = await page.evaluate(() => ({ reviewOpen: document.getElementById('review-dialog').open, accountOpen: document.getElementById('account-dialog').open, problem: document.getElementById('review-problem').value }));
  ok('ログイン導線で入力を保持したままアカウント画面へ移る', !transfer.reviewOpen && transfer.accountOpen && transfer.problem === 'xを求めよ', transfer);

  await page.keyboard.press('Escape');
  await page.click('#review-toggle');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(20);
  const escaped = await page.evaluate(() => {
    const row = window.__neoApp.getActiveRow();
    return { dialogOpen: document.getElementById('review-dialog').open, mathFocused: document.activeElement === row.mf || row.mf.shadowRoot?.contains(document.activeElement) };
  });
  ok('Escape後は元の数式へフォーカスを戻す', !escaped.dialogOpen && escaped.mathFocused, escaped);

  await page.setViewportSize({ width: 390, height: 760 });
  await page.click('#review-toggle');
  const narrow = await page.evaluate(() => ({
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    dialogOverflow: document.getElementById('review-dialog').scrollWidth > document.getElementById('review-dialog').clientWidth,
  }));
  ok('狭幅でも見直しモーダルを横スクロールさせない', !narrow.pageOverflow && !narrow.dialogOverflow, narrow);

  // dialog は window ではなく自身が縦スクロールする。会話や質問欄まで読んだあと、
  // 「一覧に戻る」と次に開く入力面の両方で見出しから読めることを固定する。
  await page.evaluate(() => {
    const result = document.getElementById('review-result');
    const setup = document.getElementById('review-setup');
    const filler = document.createElement('div');
    filler.id = 'review-scroll-reset-filler'; filler.style.height = '1600px';
    result.append(filler); setup.hidden = true; result.hidden = false;
    const dialog = document.getElementById('review-dialog');
    dialog.scrollTop = dialog.scrollHeight;
  });
  await page.click('#review-back-to-list');
  await page.waitForTimeout(80);
  const returnedToSetupTop = await page.evaluate(() => {
    const dialog = document.getElementById('review-dialog');
    const title = document.getElementById('review-dialog-title');
    const dialogBox = dialog.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    return { scrollTop: dialog.scrollTop, titleOffset: titleBox.top - dialogBox.top, setupVisible: !document.getElementById('review-setup').hidden };
  });
  ok('結果の末尾から一覧へ戻ると、実スクロール領域を先頭へ戻して見出しを表示する', returnedToSetupTop.setupVisible && returnedToSetupTop.scrollTop === 0 && returnedToSetupTop.titleOffset >= 0 && returnedToSetupTop.titleOffset < 90, returnedToSetupTop);

  await page.evaluate(() => {
    const dialog = document.getElementById('review-dialog');
    const filler = document.createElement('div');
    filler.id = 'review-scroll-reset-setup-filler'; filler.style.height = '1600px';
    document.getElementById('review-setup').append(filler);
    dialog.scrollTop = dialog.scrollHeight;
  });
  await page.click('#review-dialog-close');
  await page.click('#review-toggle');
  await page.waitForTimeout(80);
  const reopenedAtTop = await page.evaluate(() => {
    const dialog = document.getElementById('review-dialog');
    const title = document.getElementById('review-dialog-title');
    const dialogBox = dialog.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    return { scrollTop: dialog.scrollTop, titleOffset: titleBox.top - dialogBox.top, focusedProblem: document.activeElement?.id === 'review-problem' };
  });
  ok('閉じた入力面を開き直しても、問題文へフォーカスしつつ見出しから読める', reopenedAtTop.scrollTop === 0 && reopenedAtTop.titleOffset >= 0 && reopenedAtTop.titleOffset < 90 && reopenedAtTop.focusedProblem, reopenedAtTop);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
