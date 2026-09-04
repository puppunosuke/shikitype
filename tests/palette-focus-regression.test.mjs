// パレットから記号を選んだ直後も、次の物理キーが数式欄へ入ることを実操作で確認する。
// `(mod n)` の出力そのものに加え、選択後の復帰フォーカスを守る回帰テスト。
//
// 旧版は`.method-choice`（設定＞入力方式の直接入力層への切替ボタン）で英字を
// 物理キーそのまま挿入できる状態を作ってから検証していたが、`.method-choice`は
// 現在app.html側のどこにも存在せず（grep -n 'method-choice' app.htmlが0件）、
// クリック先の`[data-settings-category="input"]`もisSettingsCategoryAvailable()
// が'input'を除外している（app.js内コメント「SHIKITYPE専用化後は入力方式・
// キー割当を検索や深リンクからも出さない」）ため、設定からも到達できない。
// 変換方式の読み+Enter確定で同じ内容（英字a/b/cを普通に打てる）を再現する。
//
// 検証の過程で、Escapeでパレットを開閉する機能自体が壊れていたことが判明した
// （このテストが本来検出すべきだった実装側のバグ）。handleConversionKey()の
// Escape分岐が読み・候補の有無に関わらず常にtrueを返しており、symbol層にいる
// 限り#palette見出しが約束する「Escで開閉」のグローバルEscape処理へ絶対に
// 制御が渡らなかった（実測: 読み無しでEscapeを押してもpalette.classListに
// 'open'が付かない）。Enterの`state.raw`ガードと同じ考え方でEscapeにも
// `!state.raw && !state.candidates.length`のガードを追加し、読み・候補が
// 無いときだけ後続のグローバルEscape処理（パレット開閉）へ渡すようapp.jsを
// 修正した（このファイル内には実装コードの変更は無い）。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let failures = 0;

function assertEqual(label, actual, expected) {
  if (actual === expected) {
    console.log(`  OK  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

// 変換方式の読み+Enter確定でaを打つ（単独英字は候補が無ければそのまま確定する）。
await page.click('math-field');
await page.keyboard.press('KeyA');
await page.keyboard.press('Enter');

// 合同記号をパレットから選んだ後、物理Bが落ちないこと。
await page.keyboard.press('Escape'); // 読み・候補が無い状態のEscapeでパレットを開く
await page.getByRole('button', { name: '≡', exact: true }).click();
await page.keyboard.press('KeyB');
await page.keyboard.press('Enter');
assertEqual(
  'パレット選択後も次の物理キーを入力できる',
  await page.evaluate(() => window.__neoApp.getActiveRow().mf.value),
  String.raw`a\equiv b`,
);

// 整数の性質で使う `(mod n)` も、同じ復帰経路で正しいLaTeXを残し、その後のキーを受け取る。
await page.keyboard.press('Escape');
await page.getByRole('button', { name: '(mod n)', exact: true }).click();
assertEqual(
  '(mod n) は \\pmod{n} として挿入される',
  await page.evaluate(() => window.__neoApp.getActiveRow().mf.value),
  String.raw`a\equiv b\pmod{n}`,
);
await page.keyboard.press('KeyC');
await page.keyboard.press('Enter');
assertEqual(
  '(mod n) 選択後も次の物理キーを入力できる',
  await page.evaluate(() => window.__neoApp.getActiveRow().mf.value),
  String.raw`a\equiv b\pmod{n}c`,
);
assertEqual('画面エラーなし', JSON.stringify(pageErrors), '[]');

await browser.close();
console.log(`\n=== RESULT: ${failures === 0 ? 'passed' : 'failed'} ===`);
process.exit(failures ? 1 : 0);
