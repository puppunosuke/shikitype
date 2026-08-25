import {
  emptyConversionDictionaryState,
  effectiveConversionCandidates,
  exportConversionDictionaryCsv,
  importConversionDictionaryCsv,
  parseConversionDictionaryCsv,
  rankConversionCandidates,
} from '../conversion.js';

let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed += 1; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}
const first = (query, state) => rankConversionCandidates(query, undefined, undefined, Date.now(), 8, effectiveConversionCandidates(state))[0]?.id;

console.log('\n== 1. CSVの読込とカスタム候補 ==');
const source = `\uFEFFversion,operation,candidate_id,symbol,latex,reading,base_priority\r\n1,upsert,custom-delta,Δ,\\Delta ,でるた,360\r\n1,upsert,custom-delta,Δ,\\Delta ,差分,360\r\n1,upsert,greek-sigma,Σ,\\Sigma ,合計,300\r\n`;
let imported = importConversionDictionaryCsv(source, emptyConversionDictionaryState());
ok('BOMとCRLFを受け入れ、1読み1行を候補へまとめる', imported.accepted === 3 && imported.rejected.length === 0, imported);
ok('新規候補と既定候補へのalias追加が候補順位に反映される', first('でるた', imported.state) === 'custom-delta' && first('合計', imported.state) === 'greek-sigma', effectiveConversionCandidates(imported.state));
ok('ユーザーCSVの漢字readingは自動変換しない', exportConversionDictionaryCsv(imported.state).includes('合計'));

console.log('\n== 2. 既定aliasの削除と部分拒否 ==');
imported = importConversionDictionaryCsv('version,operation,candidate_id,symbol,latex,reading,base_priority\n1,delete,greek-sigma,,,,\n1,upsert,bad id,Σ,\\Sigma ,だめ,3\n', imported.state);
ok('候補単位の削除トゥームストーンだけを適用する', imported.accepted === 1 && imported.rejected.length === 1 && first('しぐま', imported.state) !== 'greek-sigma', imported);
ok('不正行は既存のカスタム候補を壊さない', first('でるた', imported.state) === 'custom-delta', imported.state);
const restoredAlias = importConversionDictionaryCsv('version,operation,candidate_id,symbol,latex,reading,base_priority\n1,delete,custom-delta,,,,差分\n1,upsert,custom-delta,Δ,\\Delta,差分,360\n', imported.state);
ok('削除したcustom aliasも同じupsertで復活できる', restoredAlias.rejected.length === 0 && first('差分', restoredAlias.state) === 'custom-delta', restoredAlias);

console.log('\n== 3. 引用符・カンマ・全置換の可逆性 ==');
const quoted = 'version,operation,candidate_id,symbol,latex,reading,base_priority\n1,upsert,custom-comma,"x,y",\\mathrm{xy},"読み,別名",210\n';
const quotedImport = importConversionDictionaryCsv(quoted, emptyConversionDictionaryState());
ok('RFC4180の引用符とカンマをセル内で扱う', quotedImport.accepted === 1 && first('読み,別名', quotedImport.state) === 'custom-comma', quotedImport);
const exported = exportConversionDictionaryCsv(quotedImport.state);
const restored = importConversionDictionaryCsv(exported, emptyConversionDictionaryState(), { mode: 'replace' });
ok('export→replace importで有効なカスタム辞書を復元する', restored.rejected.length === 0 && first('読み,別名', restored.state) === 'custom-comma', { exported, restored });
ok('exportは式として開始するセルを保護する', !exported.includes('\n1,upsert,custom-comma,=') && !exported.includes('\n1,upsert,custom-comma,+'), exported);
const defaultExport = exportConversionDictionaryCsv(emptyConversionDictionaryState());
const defaultReadings = parseConversionDictionaryCsv(defaultExport).rows.slice(1).map((row) => row.cells[5]);
ok('既定CSVのreading列に漢字は残らない', defaultReadings.length > 0 && defaultReadings.every((reading) => !/[\u3400-\u9fff々〆ヶ]/.test(reading)), defaultReadings.filter((reading) => /[\u3400-\u9fff々〆ヶ]/.test(reading)));

console.log('\n== 4. 壊れたCSVは状態を保持して拒否する ==');
const malformed = importConversionDictionaryCsv('version,operation\n1,"upsert', quotedImport.state);
ok('閉じていない引用符は行番号付きで拒否し、既存状態を残す', malformed.accepted === 0 && malformed.rejected[0]?.line === 2 && first('読み,別名', malformed.state) === 'custom-comma', malformed);
const parsed = parseConversionDictionaryCsv('version,operation,candidate_id\r\n1,delete,custom-comma\r\n');
ok('CSV parserはCRLFを行として数える', parsed.errors.length === 0 && parsed.rows.length === 2 && parsed.rows[1].line === 2, parsed);
const control = importConversionDictionaryCsv('version,operation,candidate_id,symbol,latex,reading,base_priority\n1,upsert,custom-new,n,\\nu,"改行\nあり",10\n', quotedImport.state);
ok('引用符内でも制御文字を含むreadingは開始行付きで拒否する', control.rejected.length === 1 && control.rejected[0].line === 2, control);

console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }
