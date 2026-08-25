// 読み変換の辞書・順位はDOMから独立して検証する。IMEや画面の見た目の検証は conversion-input.test.mjs で行う。
import {
  normalizeConversionQuery,
  rankConversionCandidates,
  emptyLearningState,
  emptyManualPriorityState,
  recordCandidateSelection,
  sanitizeLearningState,
  sanitizeManualPriorityState,
  setManualPriority,
  resetManualPriorities,
  CONVERSION_CANDIDATES,
  convertShikitypeReading,
} from '../conversion.js';

let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}
const first = (query, learning, manual) => rankConversionCandidates(query, learning, manual)[0]?.id;

console.log('\n== 1. 表記ゆれと読み途中 ==');
ok('カタカナをひらがなへ寄せる', normalizeConversionQuery(' シグマ ') === 'しぐま');
ok('全角ローマ字は英語aliasとして正規化する', normalizeConversionQuery('ＳＩＧＭＡ') === 'sigma');
const defaultAliases = CONVERSION_CANDIDATES.flatMap((candidate) => candidate.aliases.map((alias) => ({ id: candidate.id, alias, normalized: normalizeConversionQuery(alias) })));
ok('既定aliasに漢字はなく、空候補もない', defaultAliases.every(({ alias }) => alias && !/[\u3400-\u9fff々〆ヶ]/.test(alias)), defaultAliases.filter(({ alias }) => !alias || /[\u3400-\u9fff々〆ヶ]/.test(alias)));
ok('既定aliasは候補ごとに正規化後も重複しない', CONVERSION_CANDIDATES.every((candidate) => new Set(candidate.aliases.map(normalizeConversionQuery)).size === candidate.aliases.length), CONVERSION_CANDIDATES.filter((candidate) => new Set(candidate.aliases.map(normalizeConversionQuery)).size !== candidate.aliases.length));
ok('読み途中でも候補を出す', rankConversionCandidates('し').some((candidate) => candidate.id === 'greek-sigma'));

console.log('\n== 1b. SHIKITYPE専用ローマ字入力 ==');
const reading = (value) => convertShikitypeReading(value);
ok('sは未確定のまま待機する', reading('s').reading === '' && reading('s').pending === 's', reading('s'));
ok('siとshiはどちらも し', reading('si').display === 'し' && reading('shi').display === 'し', { si: reading('si'), shi: reading('shi') });
ok('sigumaは しぐま', reading('siguma').display === 'しぐま', reading('siguma'));
ok('sekibunは せきぶん', reading('sekibun').display === 'せきぶん', reading('sekibun'));
ok('登録済みの英語記号名は最後まで打つと和英混在せずに読みへ揃う', reading('integral').display === 'いんてぐらる' && reading('sigma').display === 'しぐま', { integral: reading('integral'), sigma: reading('sigma') });
ok('nとnnはどちらもんとして候補検索できる', reading('n').searchReading === 'ん' && reading('nn').searchReading === 'ん', { n: reading('n'), nn: reading('nn') });
ok('逐次入力でもnからna/ni/nyaへ正しく伸びる', reading('na').display === 'な' && reading('ni').display === 'に' && reading('nya').display === 'にゃ', { na: reading('na'), ni: reading('ni'), nya: reading('nya') });
ok('nnaとannaはんを重ねずに変換する', reading('nna').display === 'んな' && reading('anna').display === 'あんな', { nna: reading('nna'), anna: reading('anna') });
ok('konnichihaはこんにちは', reading('konnichiha').display === 'こんにちは', reading('konnichiha'));
ok('kkは促音を確定して次のkを待機する', reading('kk').reading === 'っ' && reading('kk').pending === 'k', reading('kk'));
ok('kyoは拗音になる', reading('kyo').display === 'きょ', reading('kyo'));
ok('カタカナ直接入力をひらがなへ寄せる', reading('シグマ').display === 'しぐま', reading('シグマ'));
ok('漢字の直接入力はユーザー辞書互換のため読みとして保持する', reading('総和').searchReading === '総和' && reading('数列の和').searchReading === '数列の和' && reading('積分').searchReading === '積分', { total: reading('総和'), sequence: reading('数列の和'), integral: reading('積分') });

console.log('\n== 2. 指定語とΣ/∑の区別 ==');
for (const query of ['しぐま', 'そうわ', 'わ', 'すうれつのわ']) {
  ok(`${query} の既定1位はギリシャ文字Σ`, first(query) === 'greek-sigma', rankConversionCandidates(query).map((candidate) => candidate.id));
}
for (const query of ['そうわ', 'わ', 'すうれつのわ']) {
  ok(`${query} の既定1位はギリシャ文字Σ`, first(query) === 'greek-sigma', rankConversionCandidates(query).map((candidate) => candidate.id));
}
for (const query of ['souwa', 'wa', 'suuretsunowa']) {
  const converted = reading(query);
  ok(`${query} の逐次ローマ字読みもΣを先頭候補にする`, first(converted.searchReading) === 'greek-sigma', converted);
}
ok('せきぶんの既定1位は∫', first('せきぶん') === 'integral');
ok('インテグラルの既定1位は∫', first('インテグラル') === 'integral');
ok('integralの英字入力も∫を先頭候補にする', first(reading('integral').searchReading) === 'integral', reading('integral'));
for (const [query, expected] of [['そうわ', 'greek-sigma'], ['すうれつのわ', 'greek-sigma'], ['せきぶん', 'integral'], ['きょくげん', 'limit'], ['へいほうこん', 'sqrt'], ['かくりつ', 'probability'], ['きたいち', 'expectation']]) {
  ok(`${query} は既定候補を維持する`, first(query) === expected, rankConversionCandidates(query).map((candidate) => candidate.id));
}
const sumCandidates = rankConversionCandidates('そうわ');
ok('Σと∑は別の安定IDで候補に共存する', sumCandidates.some((candidate) => candidate.id === 'greek-sigma') && sumCandidates.some((candidate) => candidate.id === 'sum-operator'), sumCandidates.map((candidate) => candidate.id));

console.log('\n== 3. 学習順位と手動順位 ==');
let learning = emptyLearningState();
for (let i = 0; i < 90; i++) learning = recordCandidateSelection(learning, 'わ', 'sum-operator', 1000 + i);
ok('同じ読みで選んだ履歴が順位へ反映される', rankConversionCandidates('わ', learning, undefined, 1100)[0]?.id === 'sum-operator', rankConversionCandidates('わ', learning, undefined, 1100).map((candidate) => [candidate.id, candidate.learnedCount]));
let manual = setManualPriority(emptyManualPriorityState(), 'sum-operator', 50);
ok('手動の最上位指定が既定順位を上書きする', first('わ', emptyLearningState(), manual) === 'sum-operator');
let overlearned = emptyLearningState();
for (let i = 0; i < 240; i++) overlearned = recordCandidateSelection(overlearned, 'わ', 'greek-sigma', 2000 + i);
manual = setManualPriority(emptyManualPriorityState(), 'sum-operator', 1);
ok('手動順位は200回超の学習より必ず優先する', rankConversionCandidates('わ', overlearned, manual, 2300)[0]?.id === 'sum-operator', rankConversionCandidates('わ', overlearned, manual, 2300).map((candidate) => [candidate.id, candidate.manualPriority, candidate.learnedCount]));
ok('学習回数は上限200を超えない', overlearned.selections['わ']['greek-sigma'].count <= 200, overlearned.selections['わ']['greek-sigma']);
manual = resetManualPriorities();
ok('手動順位のリセットで初期順位へ戻る', first('わ', emptyLearningState(), manual) === 'greek-sigma');

console.log('\n== 4. 保存値の移行・破損耐性 ==');
const restoredLearning = sanitizeLearningState({ version: 0, selections: { 'しぐま': { 'greek-sigma': { count: 2, lastUsed: 12 }, unknown: { count: 99 } } } });
ok('旧版相当の有効な学習値だけを復元する', restoredLearning.selections['しぐま']?.['greek-sigma']?.count === 2 && !restoredLearning.selections['しぐま'].unknown, restoredLearning);
const restoredManual = sanitizeManualPriorityState({ priorities: { integral: 7, unknown: 9 } });
ok('手動順位の未知候補を捨てて既知候補だけ保持する', restoredManual.priorities.integral === 7 && !('unknown' in restoredManual.priorities), restoredManual);

console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
