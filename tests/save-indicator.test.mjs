// 3. 保存された感 — #sync-status がローカル保存の「保存中」「保存済み」を
// 控えめに示すことの回帰。クラウド未ログイン時は今までずっと固定文言
// 「この端末に保存」のままだったため、保存フェーズが一切見えなかった問題を確認する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('neo-math.notes.v1'));
  await page.reload({ waitUntil: 'networkidle' });

  async function statusText() { return page.evaluate(() => document.getElementById('sync-status').textContent); }

  console.log('\n== 未ログイン（ローカル保存）== ');
  const initial = await statusText();
  ok('初期表示は保存中/保存済みを騙らない（中立表示）', initial === 'この端末に保存', initial);

  await page.click('math-field');
  await page.keyboard.press('KeyF'); // 何か1打鍵入れて保存をスケジュールさせる
  await page.waitForTimeout(80); // MathLiveの'input'イベント発火(非同期)を待つが、420msの書き込みより前
  const duringSave = await statusText();
  ok('編集直後、書き込みが終わるまでは「保存中」を示す', duringSave === '保存中…', duringSave);

  await page.waitForTimeout(420 + 200); // NOTE_SAVE_DELAY_MS(420ms)の遅延書き込みを待つ
  const afterSave = await statusText();
  ok('遅延書き込みが終わると「保存済み」を示す', afterSave === '保存済み', afterSave);

  ok('画面エラーなし', errors.length === 0, errors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) process.exit(1);
}

main();
