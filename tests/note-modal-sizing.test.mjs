// 新規ノートとキーガイドのモーダルは、候補が少ないときにviewport高へ引き伸ばさない。
// 候補が増えてもスクロールは候補面だけに閉じ、主要操作は常に押せることを確認する。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
const viewports = [{ width: 360, height: 740 }, { width: 360, height: 800 }, { width: 1024, height: 800 }];
const failures = [];
let passed = 0;
function ok(label, value, detail = value) {
  if (value) { passed += 1; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

async function dialogState(page, dialogId, actionId = null) {
  return page.evaluate(({ dialogId: id, actionId: action }) => {
    const dialog = document.getElementById(id);
    const choice = dialog.querySelector('.new-note-unit-choice');
    const actionRect = action ? document.getElementById(action)?.getBoundingClientRect() : null;
    const rect = dialog.getBoundingClientRect();
    return {
      open: dialog.open, height: rect.height, top: rect.top, bottom: rect.bottom,
      viewport: innerHeight, dialogScrollable: dialog.scrollHeight > dialog.clientHeight,
      choiceScrollable: choice.scrollHeight > choice.clientHeight,
      action: actionRect && { top: actionRect.top, bottom: actionRect.bottom },
    };
  }, { dialogId, actionId });
}

async function checkViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => failures.push({ label: `${viewport.width}x${viewport.height}: page error`, detail: error.message }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => { localStorage.removeItem('neo-math.notes.v1'); localStorage.removeItem('neo-math.unit.v1'); });
  await page.reload({ waitUntil: 'networkidle' });

  await page.click('#new-note');
  let state = await dialogState(page, 'new-note-dialog', 'new-note-create');
  ok(`${viewport.width}x${viewport.height}: 全単元の新規ノートは内容高で収まり、作成を常に押せる`,
    state.open && state.height < state.viewport - 80 && !state.dialogScrollable && state.action.top >= 0 && state.action.bottom <= state.viewport,
    state);
  await page.click('#new-note-subject-choice [data-subject-id="s3"]');
  state = await dialogState(page, 'new-note-dialog', 'new-note-create');
  ok(`${viewport.width}x${viewport.height}: 数III選択後も作成操作が画面内に残る`,
    state.height < state.viewport - 56 && !state.dialogScrollable && state.action.top >= 0 && state.action.bottom <= state.viewport,
    state);
  await page.click('#new-note-dialog-close');

  // キーガイドの単元表示ダイアログはD1で撤去済み。非表示の旧導線をクリックして
  // timeoutにするのでなく、撤去後も画面に操作の抜け殻を残さないことを確認する。
  const legacyGuideVisible = await page.locator('#guide-unit-switch').isVisible();
  ok(`${viewport.width}x${viewport.height}: 撤去済みキーガイドの単元表示導線を表示しない`, !legacyGuideVisible, legacyGuideVisible);
  await page.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  for (const viewport of viewports) await checkViewport(browser, viewport);
  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
