// 全単元ノートの範囲と、単元プリセット（キーガイド用の一時表示切替）が混ざらないことを確認する。
//
// 注記: 物理キー配列を写す#key-guide一式は、SHIKITYPEが専用変換IMEだけで完結する
// ようになったcommit cfcd009（2026-09-01）以降 `body[data-input-system="conversion"]
// #key-guide { display: none !important; }` により恒久非表示。inputSystemは
// setInputSystem()内で常に'conversion'へ強制されるため、この非表示は絶対に解除
// されない（=退役UI）。よって#guide-unit-switchのクリックや#key-guide-boardの
// キー数を検証する意味は無い。単元プリセットを切り替える現役の入口は設定サイド
// バー（#sidebar内の#unit-subject-choice / #unit-choice）だけなので、そちらを
// 経由するよう書き換えた。検証している中身（全単元ノートの範囲とプリセット表示が
// 独立して保持されること）は変えていない。
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
  }));
  ok('既定は全単元', initial.unit === 'all' && initial.course.includes('全単元'), initial);

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
  }));
  ok('個別ノートは保存単元と上バーが一致する', individual.note?.unitId === 's3-sekibun' && individual.course.includes('積分法'), individual);

  await page.click('#new-note');
  await page.click('#new-note-create'); // 全単元ノート
  await page.keyboard.press('KeyY');
  await page.keyboard.press('Enter'); // 変換方式では読みをEnterで確定しないとノート内容にならない
  await page.waitForTimeout(520);
  // 設定サイドバーの単元プリセット（現役の切替入口）で個別単元へ寄せる。
  await page.click('#sidebar-toggle');
  await page.click('#unit-subject-choice [data-choice-value="s3"]');
  await page.click('#unit-choice [data-choice-value="s3-sekibun"]');
  const allScope = await page.evaluate(() => {
    const notes = window.__neoApp.getNotes();
    const active = notes.notes.find((note) => note.id === notes.activeId);
    return {
      guide: window.__neoApp.getCurrentUnit(),
      note: active?.unitId,
      course: document.getElementById('course-label').textContent,
    };
  });
  ok('全単元ノートでは個別プリセットに寄せてもノート範囲と上バーは全単元のまま', allScope.guide === 's3-sekibun' && allScope.note === 'all' && allScope.course.includes('全単元'), allScope);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  process.exit(failures.length ? 1 : 0);
}
main();
