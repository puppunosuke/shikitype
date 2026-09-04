// 全単元ノートの範囲と、キーガイドの一時プリセットが混ざらないことを確認する。
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => failures.push({ label: 'pageerror', detail: error.message }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.removeItem('neo-math.unit.v1');
    localStorage.removeItem('neo-math.notes.v1');
  });
  await page.reload({ waitUntil: 'networkidle' });

  const initial = await page.evaluate(() => ({
    unit: window.__neoApp.getCurrentUnit(),
    course: document.getElementById('course-label').textContent,
    switchVisible: getComputedStyle(document.getElementById('guide-unit-switch')).display !== 'none',
    keyCount: document.querySelectorAll('#key-guide-board .key-cap').length,
  }));
  ok('既定は全単元で、物理QWERTY 30キーを残す', initial.unit === 'all' && initial.course.includes('全単元') && initial.switchVisible && initial.keyCount === 30, initial);

  await page.click('#new-note');
  const modal = await page.evaluate(() => ({
    open: document.getElementById('new-note-dialog').open,
    subjectSelected: document.querySelector('#new-note-subject-choice [aria-pressed="true"]')?.dataset.subjectId,
    unitChoiceEmpty: document.getElementById('new-note-unit-choice').childElementCount === 0,
  }));
  ok('新しいノートは科目選択モーダルを開き、全単元が初期選択（単元一覧は科目を選ぶまで出さない）',
    modal.open && modal.subjectSelected === 'all' && modal.unitChoiceEmpty, modal);
  // 科目→単元の二段階：先に科目（数III）を選んでから単元（積分法）を選ぶ。
  await page.click('#new-note-subject-choice [data-subject-id="s3"]');
  await page.click('#new-note-unit-choice [data-unit-id="s3-sekibun"]');
  await page.click('#new-note-create');
  await page.keyboard.press('KeyX');
  await page.keyboard.press('Enter'); // 変換方式では読みをEnterで確定しないとノート内容にならない
  await page.waitForTimeout(520);
  const individual = await page.evaluate(() => ({
    note: window.__neoApp.getNotes().notes[0],
    course: document.getElementById('course-label').textContent,
    switchVisible: getComputedStyle(document.getElementById('guide-unit-switch')).display !== 'none',
  }));
  ok('個別ノートは保存単元と上バーが一致し、全単元用切替は出ない', individual.note?.unitId === 's3-sekibun' && individual.course.includes('積分法') && !individual.switchVisible, individual);

  await page.click('#new-note');
  await page.click('#new-note-create');
  await page.keyboard.press('KeyY');
  await page.keyboard.press('Enter'); // 変換方式では読みをEnterで確定しないとノート内容にならない
  await page.waitForTimeout(520);
  await page.click('#guide-unit-switch');
  await page.click('#guide-unit-subject-choice [data-subject-id="s3"]');
  await page.click('#guide-unit-choice [data-unit-id="s3-sekibun"]');
  const allScope = await page.evaluate(() => {
    const notes = window.__neoApp.getNotes();
    const active = notes.notes.find((note) => note.id === notes.activeId);
    return {
      guide: window.__neoApp.getCurrentUnit(),
      note: active?.unitId,
      course: document.getElementById('course-label').textContent,
      title: document.getElementById('key-guide-title').textContent,
      switchVisible: getComputedStyle(document.getElementById('guide-unit-switch')).display !== 'none',
    };
  });
  ok('全単元ノートでは個別ガイドに寄せてもノート範囲と上バーは全単元のまま', allScope.guide === 's3-sekibun' && allScope.note === 'all' && allScope.course.includes('全単元') && allScope.title.includes('積分法') && allScope.switchVisible, allScope);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
