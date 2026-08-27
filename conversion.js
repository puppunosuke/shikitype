// SHIKITYPE — 読み・意味から数式記号へ変換するための、DOM非依存コア。
// 候補IDは保存済みの学習履歴と手動順位のキーになるため、表示文言とは分離して安定させる。

const ROMAJI_ALIASES = {
  sigma: 'しぐま', shiguma: 'しぐま', souwa: 'そうわ', wa: 'わ',
  integral: 'いんてぐらる', integuraru: 'いんてぐらる', sekibun: 'せきぶん',
  limit: 'りみっと', rimito: 'りみっと', root: 'るーと', sqrt: 'るーと',
  infinity: 'むげんだい', pai: 'ぱい', pii: 'ぴー', 'pi-': 'ぴー', theta: 'しーた', alpha: 'あるふぁ', beta: 'べーた',
};

// SHIKITYPE専用IME用。ここではブラウザやOSのIMEへ依存せず、物理英字キーを
// 読みに変える。末尾がまだ読みとして確定しない場合は pending に残すので、
// `s` を打った瞬間に数式や候補へ別の文字として漏らさない。
const ROMAJI_KANA = {
  kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ',
  gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
  sha: 'しゃ', shu: 'しゅ', sho: 'しょ', shi: 'し', si: 'し',
  ja: 'じゃ', ju: 'じゅ', jo: 'じょ', ji: 'じ', zi: 'じ',
  cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', chi: 'ち', ti: 'ち',
  nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
  hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
  bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
  pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
  mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
  rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
  fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
  tsa: 'つぁ', tsi: 'つぃ', tse: 'つぇ', tso: 'つぉ', tsu: 'つ', tu: 'つ',
  va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ',
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ',
  ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
  sa: 'さ', su: 'す', se: 'せ', so: 'そ',
  za: 'ざ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
  ta: 'た', te: 'て', to: 'と',
  da: 'だ', de: 'で', do: 'ど',
  na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
  ha: 'は', hi: 'ひ', hu: 'ふ', fu: 'ふ', he: 'へ', ho: 'ほ',
  ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
  pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
  ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
  ya: 'や', yu: 'ゆ', yo: 'よ',
  ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
  wa: 'わ', wo: 'を',
  a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
};
const ROMAJI_KEYS = Object.keys(ROMAJI_KANA).sort((a, b) => b.length - a.length);
const ROMAJI_PREFIXES = new Set(ROMAJI_KEYS.flatMap((key) => Array.from({ length: key.length }, (_, i) => key.slice(0, i + 1))));

function toHiraganaChar(char) {
  const code = char.codePointAt(0);
  return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : char;
}

function convertRomajiRun(run) {
  let reading = '';
  let index = 0;
  while (index < run.length) {
    const rest = run.slice(index);
    const first = rest[0];
    // `kk` の一つ目は促音にし、二つ目は次の音節の未確定末尾として保つ。
    if (rest.length >= 2 && first === rest[1] && /^[bcdfghjklmpqrstvwxyz]$/.test(first) && first !== 'n') {
      reading += 'っ';
      index += 1;
      continue;
    }
    // 語尾の `n` は次打鍵でna/ni/nyaへ伸び得るので、生の打鍵列では保留する。
    // 候補検索用には convertShikitypeReading() がこの保留nを「ん」として扱う。
    if (first === 'n') {
      if (rest.startsWith('nn')) {
        // nna / nnya / konnichiha は、最初のnだけをんへ確定して残りを次の音節へ渡す。
        if (rest.length > 2) { reading += 'ん'; index += 1; continue; }
        reading += 'ん'; index += 2; continue;
      }
      if (rest.length === 1) return { reading, pending: rest };
      if (!/[aiueoyn]/.test(rest[1])) { reading += 'ん'; index += 1; continue; }
    }
    const key = ROMAJI_KEYS.find((candidate) => rest.startsWith(candidate));
    if (key) {
      reading += ROMAJI_KANA[key];
      index += key.length;
      continue;
    }
    if (ROMAJI_PREFIXES.has(rest)) return { reading, pending: rest };
    // 読みとして解釈できない英字は、先頭だけ保留にして次打鍵を待つ。
    return { reading, pending: rest };
  }
  return { reading, pending: '' };
}

/**
 * ひらがな・カタカナの直接入力と、物理英字キーのローマ字入力を一つの読みへまとめる。
 * raw romajiは呼び出し側で保持し続ける。displayは入力欄にそのまま出す文字列、
 * searchReadingは候補検索に渡す読み（語尾nは「ん」として検索できる）。
 */
export function convertShikitypeReading(value) {
  const source = String(value ?? '').normalize('NFKC');
  // `pi` は「ぴ」の途中であり、πの読みではない。ここで `pi` を `ぱい` と
  // 扱うと、英字Pを入れたい途中打鍵がπ候補へ化ける。`pai`だけをπの読みとし、
  // `pii`/`pi-` はアルファベットP用の長音として明示的に扱う。
  const exactAlias = ROMAJI_ALIASES[source.toLowerCase()];
  if (exactAlias) return { reading: exactAlias, searchReading: exactAlias, pending: '', display: exactAlias };
  let reading = '';
  let searchReading = '';
  let pending = '';
  let display = '';
  let roman = '';
  const flushRoman = () => {
    if (!roman) return;
    const normalizedRoman = roman.toLowerCase();
    // 記号名として登録したローマ字は、最後まで打ち切った時点で辞書の読みへ
    // 揃える。通常のローマ字表に無い `integral` / `sigma` を、途中の
    // `いんてgral` のような和英混在表示で残さないための専用IME規則。
    const aliasReading = ROMAJI_ALIASES[normalizedRoman];
    if (aliasReading) {
      reading += aliasReading;
      searchReading += aliasReading;
      display += aliasReading;
      pending = '';
      roman = '';
      return;
    }
    const result = convertRomajiRun(normalizedRoman);
    reading += result.reading;
    searchReading += result.reading + (result.pending === 'n' ? 'ん' : '');
    // 生の末尾nはstate.rawに残したまま、読み入力面では「ん」と見せる。
    // これならsekibunの候補を自然に読め、次打鍵aではrawを再解析してなへ直せる。
    display += result.reading + (result.pending === 'n' ? 'ん' : result.pending);
    pending = result.pending;
    roman = '';
  };
  for (const char of source) {
    if (/[A-Za-z]/.test(char)) {
      roman += char;
      continue;
    }
    flushRoman();
    if (/[぀-ゟ゠-ヿー]/.test(char)) {
      const kana = toHiraganaChar(char);
      reading += kana;
      searchReading += kana;
      display += kana;
      pending = '';
    } else if (/[\u3400-\u9fff々〆ヶ]/.test(char)) {
      // 意味入力（総和・数列の和・積分など）はかなに無理に変換しない。
      // 辞書の漢字aliasと同じ検索語として、そのまま保持する。
      reading += char;
      searchReading += char;
      display += char;
      pending = '';
    }
  }
  flushRoman();
  // readingはUI/API向けに候補検索と同じ「今読める読み」を返す。未確定末尾は
  // pendingとして別に持つため、次打鍵時のローマ字解析は失われない。
  return { reading: searchReading, searchReading, pending, display };
}

// 既定辞書は「高校生が大学受験の数式を書く」ための辞書に限定する。
// パレットそのものは全ギリシャ文字を提供するが、読みからの変換候補へは
// 高校数学I・A・II・B・III・Cおよび入試頻出の記号だけを載せる。
// scope と examUnits は表示/UIの依存を持たない監査用メタデータ。後から
// 単元プリセットがこの対応表を利用しても、CSV形式や安定IDには影響しない。
export const HIGH_SCHOOL_EXAM_SCOPE = Object.freeze({
  included: 'high-school-exam',
  compatibility: 'compatibility-only',
  units: Object.freeze(['math1', 'mathA', 'math2', 'mathB', 'math3', 'mathC']),
});

const GREEK_LETTERS = [
  ['alpha', 'α', 'Α', 'あるふぁ'], ['beta', 'β', 'Β', 'べーた'], ['gamma', 'γ', 'Γ', 'がんま'], ['delta', 'δ', 'Δ', 'でるた'],
  ['epsilon', 'ε', 'Ε', 'いぷしろん'], ['zeta', 'ζ', 'Ζ', 'ぜーた'], ['eta', 'η', 'Η', 'いーた'], ['theta', 'θ', 'Θ', 'しーた'],
  ['iota', 'ι', 'Ι', 'いおた'], ['kappa', 'κ', 'Κ', 'かっぱ'], ['lambda', 'λ', 'Λ', 'らむだ'], ['mu', 'μ', 'Μ', 'みゅー'],
  ['nu', 'ν', 'Ν', 'にゅー'], ['xi', 'ξ', 'Ξ', 'くさい'], ['omicron', 'ο', 'Ο', 'おみくろん'], ['pi', 'π', 'Π', 'ぱい'],
  ['rho', 'ρ', 'Ρ', 'ろー'], ['sigma', 'σ', 'Σ', 'しぐま'], ['tau', 'τ', 'Τ', 'たう'], ['upsilon', 'υ', 'Υ', 'うぷしろん'],
  ['phi', 'φ', 'Φ', 'ふぁい'], ['chi', 'χ', 'Χ', 'かい'], ['psi', 'ψ', 'Ψ', 'ぷさい'], ['omega', 'ω', 'Ω', 'おめが'],
];
const JAPANESE_LATIN_NAMES = ['えー','びー','しー','でぃー','いー','えふ','じー','えいち','あい','じぇー','けー','える','えむ','えぬ','おー','ぴー','きゅー','あーる','えす','てぃー','ゆー','ぶい','だぶりゅー','えっくす','わい','ぜっと'];
const LETTER_CANDIDATES = Array.from({ length: 26 }, (_, index) => {
  const lower = String.fromCharCode(97 + index); const upper = lower.toUpperCase(); const reading = JAPANESE_LATIN_NAMES[index];
  return [
    // アルファベットは高校数学でも変数・点・集合名として全字を使う。一方、
    // 英語の言い回しを何通りも既定aliasへ入れるとCSVが膨れ、候補も散るため、
    // 大小文字を指定する最小限の読みだけにする。
    { id: `latin-lower-${lower}`, label: lower, latex: lower, aliases: [`${reading}こもじ`, `lower ${lower}`], categories: ['latin'], basePriority: 130 },
    ...(lower === 'p' ? [] : [{ id: `latin-uppercase-${lower}`, label: upper, latex: upper, aliases: [upper, reading, `upper ${lower}`], categories: ['latin'], basePriority: 160 }]),
  ];
}).flat();
const EXISTING_GREEK_LOWER = new Set(['alpha','beta','gamma','theta','lambda','mu','rho','omega','pi']);
const GREEK_LATEX = Object.freeze({ alpha: '\\alpha ', beta: '\\beta ', gamma: '\\gamma ', delta: '\\delta ', epsilon: '\\epsilon ', zeta: '\\zeta ', eta: '\\eta ', theta: '\\theta ', iota: '\\iota ', kappa: '\\kappa ', lambda: '\\lambda ', mu: '\\mu ', nu: '\\nu ', xi: '\\xi ', omicron: 'o', pi: '\\pi ', rho: '\\rho ', sigma: '\\sigma ', tau: '\\tau ', upsilon: '\\upsilon ', phi: '\\phi ', chi: '\\chi ', psi: '\\psi ', omega: '\\omega ' });
const GREEK_UPPER_LATEX = Object.freeze({ gamma: '\\Gamma ', delta: '\\Delta ', theta: '\\Theta ', lambda: '\\Lambda ', xi: '\\Xi ', pi: '\\Pi ', sigma: '\\Sigma ', phi: '\\Phi ', psi: '\\Psi ', omega: '\\Omega ' });
const GREEK_UPPER_ROMAN = Object.freeze({ alpha:'A', beta:'B', epsilon:'E', zeta:'Z', eta:'H', iota:'I', kappa:'K', mu:'M', nu:'N', omicron:'O', rho:'P', tau:'T', upsilon:'Y', chi:'X' });
const GREEK_CANDIDATES = GREEK_LETTERS.flatMap(([name, lower, upper, reading]) => [
  ...(EXISTING_GREEK_LOWER.has(name) ? [] : [{ id: `greek-${name}-lower`, greekName: name, label: lower, latex: GREEK_LATEX[name], aliases: [name, lower, reading, `${reading}こもじ`, `lower ${name}`], categories: ['greek'], basePriority: 170 }]),
  { id: `greek-${name}-upper`, greekName: name, label: upper, latex: GREEK_UPPER_LATEX[name] ?? `\\mathrm{${GREEK_UPPER_ROMAN[name]}}`, aliases: [`upper ${name}`, `${reading}だいもじ`, upper], categories: ['greek'], basePriority: 140 },
]);
const MATH_CANDIDATE_DEFINITIONS = [
  ['product','∏','\\prod ','せき','product','prod'], ['fraction','÷','\\div ','わる','じょほう','division','divide'], ['approximately','≈','\\approx ','きんじ','ほぼ','approx'],
  ['proportional','∝','\\propto ','ひれい','proportional','propto'], ['subset','⊂','\\subset ','ぶぶんしゅうごう','subset'],
  ['subset-equal','⊆','\\subseteq ','ぶぶんしゅうごういこーる','subseteq'], ['superset','⊃','\\supset ','ほうがん','superset'],
  ['superset-equal','⊇','\\supseteq ','ほうがんいこーる','supseteq'], ['not-belongs','∉','\\notin ','ぞくさない','notin'],
  ['forall','∀','\\forall ','すべて','にんい','forall'], ['exists','∃','\\exists ','そんざい','exists'],
  ['negation','¬','\\neg ','ひてい','negation','not'], ['and','∧','\\land ','かつ','ろんりせき','and'],
  ['or','∨','\\lor ','または','ろんりわ','or'], ['equivalent','⇔','\\Leftrightarrow ','どうち','equivalent','iff'],
  ['implies','⇒','\\Rightarrow ','ならば','がんい','implies'], ['degree','°','^\\circ ','ど','かくど','degree'],
  ['prime','′','\\prime ','ぷらいむ','どうかんすう','prime'], ['percent','%','\\% ','ぱーせんと','ひゃくぶんりつ','percent'],
  ['factorial','!','!','かいじょう','factorial','fact'], ['absolute','|x|','\\left|#0\\right|','ぜったいち','absolute'],
  ['floor','⌊⌋','\\lfloor #0 \\rfloor','がうす','ゆかかんすう','floor'], ['ceiling','⌈⌉','\\lceil #0 \\rceil','しーりんぐ','てんじょうかんすう','ceiling'],
  ['derivative','d/dx','\\frac{d}{dx}','びぶん','derivative','d dx'], ['probability','P','P','かくりつ','probability','prob'],
  ['expectation','E','E','きたいち','expectation','expected value'], ['variance','V','V','ぶんさん','variance','var'],
  ['coordinate','(x,y)','\\left(#0,#0\\right)','ざひょう','coordinate'], ['vector','→','\\vec{#0}','べくとる','vector','vec'],
];
const MATH_CANDIDATES = MATH_CANDIDATE_DEFINITIONS
  .map(([id, label, latex, ...aliases]) => ({ id, label, latex, aliases, categories: ['general'], basePriority: 125 }));

const EXAM_GREEK_NAMES = new Set(['alpha', 'beta', 'gamma', 'delta', 'theta', 'lambda', 'mu', 'rho', 'sigma', 'phi', 'omega', 'pi']);
const EXAM_GREEK_UNITS = Object.freeze({
  alpha: ['math1', 'math2'], beta: ['math1', 'math2'], gamma: ['math1', 'mathA'], delta: ['math2'], theta: ['math1', 'math2'],
  lambda: ['math2', 'math3'], mu: ['mathB'], rho: ['math3'], sigma: ['mathB', 'math3'], phi: ['math1', 'mathA'], omega: ['math3'], pi: ['math1', 'math2'],
});
const withExamScope = (candidate, examUnits) => ({ ...candidate, scope: HIGH_SCHOOL_EXAM_SCOPE.included, examUnits });
const withCompatibilityScope = (candidate) => ({ ...candidate, scope: HIGH_SCHOOL_EXAM_SCOPE.compatibility, examUnits: [] });
const examGreekCandidates = GREEK_CANDIDATES
  .filter((candidate) => EXAM_GREEK_NAMES.has(candidate.greekName))
  .map(({ greekName, ...candidate }) => withExamScope(candidate, EXAM_GREEK_UNITS[greekName]));
const legacyGreekCandidates = GREEK_CANDIDATES
  .filter((candidate) => !EXAM_GREEK_NAMES.has(candidate.greekName))
  .map(({ greekName, ...candidate }) => withCompatibilityScope(candidate));
const examMathCandidateIds = new Set([
  'fraction', 'approximately', 'proportional', 'subset', 'subset-equal', 'superset', 'superset-equal', 'not-belongs',
  'equivalent', 'implies', 'degree', 'prime', 'percent', 'factorial', 'absolute', 'derivative', 'probability', 'expectation', 'variance', 'coordinate', 'vector',
]);
const examMathCandidates = MATH_CANDIDATES
  .filter((candidate) => examMathCandidateIds.has(candidate.id))
  .map((candidate) => withExamScope(candidate, candidate.id === 'derivative' || candidate.id === 'prime' ? ['math2', 'math3']
    : candidate.id === 'vector' ? ['mathC']
      : ['math1', 'mathA', 'math2', 'mathB', 'mathC']));
const legacyMathCandidates = MATH_CANDIDATES
  .filter((candidate) => !examMathCandidateIds.has(candidate.id))
  .map(withCompatibilityScope);

const HIGH_SCHOOL_EXAM_CANDIDATES = [
  withExamScope({ id: 'greek-sigma', label: 'Σ', latex: '\\Sigma ', aliases: ['しぐま', 'そうわ', 'わ', 'すうれつのわ', 'sigma', 'sum'], categories: ['general', 'greek'], basePriority: 300 }, ['mathB', 'math3']),
  withExamScope({ id: 'sum-operator', label: '∑', latex: '\\sum ', aliases: ['そうわきごう', 'しーぐま', 'わのえんざんし', 'sum'], categories: ['general'], basePriority: 190 }, ['mathB', 'math3']),
  withExamScope({ id: 'integral', label: '∫', latex: '\\int ', aliases: ['せきぶん', 'いんてぐらる', 'integral', 'int'], categories: ['general'], basePriority: 300 }, ['math2', 'math3']),
  withExamScope({ id: 'limit', label: 'lim', latex: '\\lim ', aliases: ['りみっと', 'きょくげん', 'lim', 'limit'], categories: ['general'], basePriority: 260 }, ['math3']),
  withExamScope({ id: 'infinity', label: '∞', latex: '\\infty ', aliases: ['むげん', 'むげんだい', 'infinity'], categories: ['general'], basePriority: 250 }, ['math3']),
  withExamScope({ id: 'sqrt', label: '√', latex: '\\sqrt{}', aliases: ['るーと', 'へいほうこん', 'sqrt'], categories: ['general'], basePriority: 240 }, ['math1', 'math2']),
  withExamScope({ id: 'pi', label: 'π', latex: '\\pi ', aliases: ['ぱい', 'えんしゅうりつ', 'pai', 'pi'], categories: ['greek'], basePriority: 230 }, ['math1', 'math2']),
  withExamScope({ id: 'latin-uppercase-p', label: 'P', latex: 'P', aliases: ['p', 'ぴー', 'ぴい', 'pi-', 'pii'], categories: ['latin'], basePriority: 300 }, ['mathA', 'mathB']),
  withExamScope({ id: 'greek-alpha', label: 'α', latex: '\\alpha ', aliases: ['あるふぁ', 'alpha'], categories: ['greek'], basePriority: 220 }, ['math1', 'math2']),
  withExamScope({ id: 'greek-beta', label: 'β', latex: '\\beta ', aliases: ['べーた', 'beta'], categories: ['greek'], basePriority: 210 }, ['math1', 'math2']),
  withExamScope({ id: 'greek-gamma', label: 'γ', latex: '\\gamma ', aliases: ['がんま', 'gamma'], categories: ['greek'], basePriority: 205 }, ['math1', 'mathA']),
  withExamScope({ id: 'greek-theta', label: 'θ', latex: '\\theta ', aliases: ['しーた', 'theta'], categories: ['greek'], basePriority: 205 }, ['math1', 'math2']),
  withExamScope({ id: 'greek-lambda', label: 'λ', latex: '\\lambda ', aliases: ['らむだ', 'lambda'], categories: ['greek'], basePriority: 195 }, ['math2', 'math3']),
  withExamScope({ id: 'greek-mu', label: 'μ', latex: '\\mu ', aliases: ['みゅー', 'mu'], categories: ['greek'], basePriority: 190 }, ['mathB']),
  withExamScope({ id: 'greek-rho', label: 'ρ', latex: '\\rho ', aliases: ['ろー', 'rho'], categories: ['greek'], basePriority: 180 }, ['math3']),
  withExamScope({ id: 'greek-omega', label: 'ω', latex: '\\omega ', aliases: ['おめが', 'omega'], categories: ['greek'], basePriority: 180 }, ['math3']),
  withExamScope({ id: 'plus-minus', label: '±', latex: '\\pm ', aliases: ['ぷらすまいなす', 'せいふ'], categories: ['general'], basePriority: 180 }, ['math1', 'math2']),
  withExamScope({ id: 'not-equal', label: '≠', latex: '\\ne ', aliases: ['のっといこーる', 'ひとしくない', 'ふとうごう'], categories: ['general'], basePriority: 180 }, ['math1', 'math2']),
  withExamScope({ id: 'less-equal', label: '≤', latex: '\\le ', aliases: ['しょうなりいこーる', 'いか'], categories: ['general'], basePriority: 185 }, ['math1', 'math2']),
  withExamScope({ id: 'greater-equal', label: '≥', latex: '\\ge ', aliases: ['だいなりいこーる', 'いじょう'], categories: ['general'], basePriority: 185 }, ['math1', 'math2']),
  withExamScope({ id: 'arrow', label: '→', latex: '\\to ', aliases: ['やじるし', 'arrow', 'to'], categories: ['general'], basePriority: 180 }, ['math1', 'math2', 'math3', 'mathC']),
  withExamScope({ id: 'therefore', label: '∴', latex: '\\therefore ', aliases: ['ゆえに', 'したがって'], categories: ['general'], basePriority: 170 }, ['math1', 'mathA']),
  withExamScope({ id: 'because', label: '∵', latex: '\\because ', aliases: ['なぜなら', 'なぜならば'], categories: ['general'], basePriority: 160 }, ['math1', 'mathA']),
  withExamScope({ id: 'belongs-to', label: '∈', latex: '\\in ', aliases: ['ぞくする', 'ようそ', 'element'], categories: ['general'], basePriority: 160 }, ['math1']),
  withExamScope({ id: 'union', label: '∪', latex: '\\cup ', aliases: ['ゆにおん', 'わしゅうごう'], categories: ['general'], basePriority: 160 }, ['math1']),
  withExamScope({ id: 'intersection', label: '∩', latex: '\\cap ', aliases: ['きょうつうぶぶん', 'せきしゅうごう'], categories: ['general'], basePriority: 160 }, ['math1']),
  withExamScope({ id: 'empty-set', label: '∅', latex: '\\emptyset ', aliases: ['くうしゅうごう'], categories: ['general'], basePriority: 150 }, ['math1']),
  withExamScope({ id: 'parallel', label: '∥', latex: '\\parallel ', aliases: ['へいこう'], categories: ['general'], basePriority: 150 }, ['math1', 'mathA']),
  withExamScope({ id: 'perpendicular', label: '⊥', latex: '\\perp ', aliases: ['すいちょく'], categories: ['general'], basePriority: 150 }, ['math1', 'mathA']),
  withExamScope({ id: 'angle', label: '∠', latex: '\\angle ', aliases: ['かく'], categories: ['general'], basePriority: 145 }, ['math1', 'mathA']),
  ...LETTER_CANDIDATES.map((candidate) => withExamScope(candidate, HIGH_SCHOOL_EXAM_SCOPE.units)),
  ...examGreekCandidates,
  ...examMathCandidates,
];

// 以前の辞書で公開済みのIDは、ユーザーCSVを読み直したときに失わない。
// ただしこれらは既定の読み・CSV exportには含めず、明示的にCSVでupsertした
// 読みだけを有効化する。大学専門寄りの候補を既定から外すことと互換性を両立する。
const COMPATIBILITY_CANDIDATES = [
  withCompatibilityScope({ id: 'double-integral', label: '∬', latex: '\\iint ', aliases: ['にじゅうせきぶん', 'じゅうせきぶん'], categories: ['general'], basePriority: 180 }),
  withCompatibilityScope({ id: 'partial', label: '∂', latex: '\\partial ', aliases: ['へんびぶん', 'ぱーしゃる'], categories: ['general'], basePriority: 190 }),
  withCompatibilityScope({ id: 'nabla', label: '∇', latex: '\\nabla ', aliases: ['なぶら', 'こうばい'], categories: ['general'], basePriority: 170 }),
  ...legacyGreekCandidates,
  ...legacyMathCandidates,
];

function normalizeCandidate(candidate) {
  return {
    ...candidate,
    // 既定辞書は読み仮名だけを持つ。カタカナは検索時にもひらがなへ寄るため、
    // 重複した既定aliasを残さない。
    aliases: [...new Set(candidate.aliases.map((alias) => katakanaToHiragana(String(alias).normalize('NFKC'))))],
  };
}

export const CONVERSION_CANDIDATES = HIGH_SCHOOL_EXAM_CANDIDATES.map(normalizeCandidate);
const KNOWN_CONVERSION_CANDIDATES = [...CONVERSION_CANDIDATES, ...COMPATIBILITY_CANDIDATES.map(normalizeCandidate)];

// ユーザー辞書は既定辞書を直接書き換えず、追加行と削除トゥームストーンだけを
// 保存する。将来既定辞書を更新しても、利用者が消した読みは復活しない。
export const CONVERSION_DICTIONARY_VERSION = 1;
export const CONVERSION_DICTIONARY_LIMITS = Object.freeze({
  maxBytes: 128 * 1024,
  maxRows: 2000,
  maxCustomCandidates: 300,
  maxAliasesPerCandidate: 120,
  maxLabelLength: 32,
  maxLatexLength: 160,
  maxReadingLength: 80,
  minPriority: -1000,
  maxPriority: 1000,
});

const candidateIdPattern = /^[a-z][a-z0-9-]{1,63}$/;
// 構造候補の #0 placeholder と \% はCSV往復でも正規の数式入力。危険なHTML系
// commandは下のdenylistで別途拒否するため、ここではこれらの安全な字句を許可する。
const safeLatexPattern = /^[A-Za-z0-9\\{}[\]()_^+\-*/=<>|.,:;!?#% \t]+$/;
const unsafeLatexCommand = /\\(?:html|class|style|href|url|includegraphics)\b/i;

export function emptyConversionDictionaryState() {
  return { version: CONVERSION_DICTIONARY_VERSION, additions: {}, addedAliases: {}, deletedAliases: {}, deletedCandidates: [] };
}

function candidateId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return candidateIdPattern.test(id) ? id : null;
}

function cleanReading(value) {
  const reading = String(value ?? '').normalize('NFKC').trim();
  return reading && reading.length <= CONVERSION_DICTIONARY_LIMITS.maxReadingLength && !/[\u0000-\u001f\u007f]/.test(reading) ? reading : null;
}

function cleanLabel(value) {
  const label = String(value ?? '').normalize('NFKC').trim();
  return label && label.length <= CONVERSION_DICTIONARY_LIMITS.maxLabelLength && !/[\u0000-\u001f\u007f]/.test(label) ? label : null;
}

function cleanLatex(value) {
  const latex = String(value ?? '').trim();
  return latex && latex.length <= CONVERSION_DICTIONARY_LIMITS.maxLatexLength
    && safeLatexPattern.test(latex) && !unsafeLatexCommand.test(latex) ? latex : null;
}

function cleanPriority(value) {
  const priority = Number(value);
  return Number.isInteger(priority) && priority >= CONVERSION_DICTIONARY_LIMITS.minPriority && priority <= CONVERSION_DICTIONARY_LIMITS.maxPriority
    ? priority : null;
}

function uniqueAliases(values) {
  const aliases = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const alias = cleanReading(value);
    const normalized = alias && normalizeConversionQuery(alias);
    if (!alias || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(alias);
  }
  return aliases.slice(0, CONVERSION_DICTIONARY_LIMITS.maxAliasesPerCandidate);
}

function defaultCandidateById(id) {
  return CONVERSION_CANDIDATES.find((candidate) => candidate.id === id) ?? null;
}

// compatibility-only候補は既定では出さないが、過去に書き出したCSVを
// 再インポートしたときにID・記号・LaTexの定義を検証するためにだけ参照する。
function knownCandidateById(id) {
  return KNOWN_CONVERSION_CANDIDATES.find((candidate) => candidate.id === id) ?? null;
}

/** 壊れた保存値を捨て、追加・削除だけを安全な最小状態へ寄せる。 */
export function sanitizeConversionDictionaryState(value) {
  const next = emptyConversionDictionaryState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return next;
  const source = value;
  const additions = source.additions && typeof source.additions === 'object' && !Array.isArray(source.additions) ? source.additions : {};
  for (const [rawId, rawCandidate] of Object.entries(additions)) {
    if (Object.keys(next.additions).length >= CONVERSION_DICTIONARY_LIMITS.maxCustomCandidates) break;
    const id = candidateId(rawId);
    if (!id || knownCandidateById(id) || !rawCandidate || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) continue;
    const item = rawCandidate;
    const label = cleanLabel(item.label);
    const latex = cleanLatex(item.latex);
    const basePriority = cleanPriority(item.basePriority);
    const aliases = uniqueAliases(item.aliases);
    if (!label || !latex || basePriority === null || !aliases.length) continue;
    next.additions[id] = { id, label, latex, basePriority, aliases };
  }
  const addedAliases = source.addedAliases && typeof source.addedAliases === 'object' && !Array.isArray(source.addedAliases) ? source.addedAliases : {};
  for (const [rawId, rawAliases] of Object.entries(addedAliases)) {
    const id = candidateId(rawId);
    if (!id || !knownCandidateById(id) || !Array.isArray(rawAliases)) continue;
    const aliases = uniqueAliases(rawAliases);
    if (aliases.length) next.addedAliases[id] = aliases;
  }
  const deletedAliases = source.deletedAliases && typeof source.deletedAliases === 'object' && !Array.isArray(source.deletedAliases) ? source.deletedAliases : {};
  for (const [rawId, rawAliases] of Object.entries(deletedAliases)) {
    const id = candidateId(rawId);
    if (!id || !Array.isArray(rawAliases)) continue;
    const aliases = uniqueAliases(rawAliases);
    if (aliases.length) next.deletedAliases[id] = aliases;
  }
  const deleted = Array.isArray(source.deletedCandidates) ? source.deletedCandidates : [];
  next.deletedCandidates = [...new Set(deleted.map(candidateId).filter(Boolean))].slice(0, CONVERSION_DICTIONARY_LIMITS.maxCustomCandidates);
  return next;
}

export function effectiveConversionCandidates(dictionary = emptyConversionDictionaryState()) {
  const state = sanitizeConversionDictionaryState(dictionary);
  const deletedCandidates = new Set(state.deletedCandidates);
  const result = [];
  // compatibility-only候補は、既存CSVが明示的に読みを追加した場合だけ復帰する。
  // これで高等学校向けの既定CSVを小さく保ちつつ、過去のCSVを壊さない。
  const activatedCompatibility = KNOWN_CONVERSION_CANDIDATES
    .filter((candidate) => candidate.scope === HIGH_SCHOOL_EXAM_SCOPE.compatibility && (state.addedAliases[candidate.id] ?? []).length)
    .map((candidate) => ({ ...candidate, aliases: [] }));
  const all = [...CONVERSION_CANDIDATES, ...activatedCompatibility, ...Object.values(state.additions)];
  const seenIds = new Set();
  for (const candidate of all) {
    // 既定candidateのstable IDは学習履歴/手動順位のキー。壊れたCSVや直接保存値が
    // 同じIDを持っていても、既定定義を上書きせず最初の一件だけを採用する。
    if (seenIds.has(candidate.id)) continue;
    seenIds.add(candidate.id);
    if (deletedCandidates.has(candidate.id)) continue;
    const deleted = new Set((state.deletedAliases[candidate.id] ?? []).map(normalizeConversionQuery));
    const aliases = uniqueAliases([...candidate.aliases, ...(state.addedAliases[candidate.id] ?? [])])
      .filter((alias) => !deleted.has(normalizeConversionQuery(alias)));
    if (!aliases.length) continue;
    result.push({ ...candidate, aliases });
  }
  return result;
}

function csvCell(value) {
  let text = String(value ?? '');
  // 表計算ソフトで開いたときに数式として評価させない。import側でこの保護記号は
  // 外すので、SHIKITYPE間のexport/importは可逆のままにする。
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function unprotectCsvCell(value) {
  const text = String(value ?? '');
  return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
}

/** 現在有効な辞書と削除トゥームストーンを、1読み1行の可逆CSVへ出す。 */
export function exportConversionDictionaryCsv(dictionary = emptyConversionDictionaryState()) {
  const state = sanitizeConversionDictionaryState(dictionary);
  const rows = [['version', 'operation', 'candidate_id', 'symbol', 'latex', 'reading', 'base_priority']];
  for (const candidate of effectiveConversionCandidates(state)) {
    for (const reading of candidate.aliases) rows.push([CONVERSION_DICTIONARY_VERSION, 'upsert', candidate.id, candidate.label, candidate.latex, reading, candidate.basePriority]);
  }
  for (const [id, aliases] of Object.entries(state.deletedAliases)) {
    for (const reading of aliases) rows.push([CONVERSION_DICTIONARY_VERSION, 'delete', id, '', '', reading, '']);
  }
  for (const id of state.deletedCandidates) rows.push([CONVERSION_DICTIONARY_VERSION, 'delete', id, '', '', '', '']);
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** RFC4180の引用符・CRLF・セル内改行を扱う。CSVはデータであってHTMLとして扱わない。 */
export function parseConversionDictionaryCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (new TextEncoder().encode(source).byteLength > CONVERSION_DICTIONARY_LIMITS.maxBytes) return { rows: [], errors: [{ line: 1, reason: 'CSVは128KiB以内にしてください' }] };
  const rows = [];
  const errors = [];
  let row = []; let cell = ''; let quoted = false; let afterQuote = false; let line = 1; let rowStart = 1;
  const pushCell = () => { row.push(cell); cell = ''; afterQuote = false; };
  const pushRow = () => { pushCell(); rows.push({ line: rowStart, cells: row }); row = []; };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; }
        else { quoted = false; afterQuote = true; }
      } else { cell += char; if (char === '\n') line += 1; }
      continue;
    }
    if (afterQuote && char !== ',' && char !== '\r' && char !== '\n') {
      errors.push({ line, reason: '引用符の後にはカンマか改行だけを置けます' });
      return { rows: [], errors };
    }
    if (char === '"') {
      if (cell) { errors.push({ line, reason: '引用符はセルの先頭で開始してください' }); return { rows: [], errors }; }
      quoted = true;
    } else if (char === ',') pushCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      pushRow(); line += 1; rowStart = line;
    } else cell += char;
  }
  if (quoted) return { rows: [], errors: [{ line, reason: '引用符が閉じていません' }] };
  if (cell || row.length) pushRow();
  if (rows.length > CONVERSION_DICTIONARY_LIMITS.maxRows + 1) return { rows: [], errors: [{ line: 1, reason: 'CSVは2000行以内にしてください' }] };
  return { rows, errors };
}

const csvHeaderNames = Object.freeze({
  version: ['version', 'バージョン', '形式'],
  operation: ['operation', '操作', 'operation_type'],
  candidate_id: ['candidate_id', 'candidateid', 'id', '候補id', '候補_id'],
  symbol: ['symbol', 'label', '記号', '表示'],
  latex: ['latex', 'tex', '数式'],
  reading: ['reading', 'alias', '読み', 'よみ'],
  base_priority: ['base_priority', 'basepriority', 'priority', '基本優先度', '優先度'],
});

function csvHeaderKey(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[ _-]/g, '');
}

function csvColumns(header) {
  const map = {};
  for (const [name, names] of Object.entries(csvHeaderNames)) {
    const index = header.findIndex((cell) => names.some((alias) => csvHeaderKey(alias) === csvHeaderKey(cell)));
    if (index >= 0) map[name] = index;
  }
  return map;
}

function csvValue(cells, columns, name) {
  const index = columns[name];
  return index === undefined ? '' : unprotectCsvCell(cells[index] ?? '').trim();
}

function normalizeOperation(value) {
  const op = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  if (['upsert', 'add', 'update', '追加', '更新'].includes(op)) return 'upsert';
  if (['delete', 'remove', '削除', '無効化'].includes(op)) return 'delete';
  return null;
}

/**
 * CSVを差分状態へ適用する。壊れた行だけを拒否し、受理済みの行は残す。
 * mode=replaceはユーザー差分をいったん空にしてからCSVを適用する安全な全置換。
 */
export function importConversionDictionaryCsv(text, current = emptyConversionDictionaryState(), { mode = 'merge' } = {}) {
  const parsed = parseConversionDictionaryCsv(text);
  if (parsed.errors.length) return { state: sanitizeConversionDictionaryState(current), accepted: 0, rejected: parsed.errors, total: 0 };
  if (!parsed.rows.length) return { state: sanitizeConversionDictionaryState(current), accepted: 0, rejected: [{ line: 1, reason: 'ヘッダー行がありません' }], total: 0 };
  const columns = csvColumns(parsed.rows[0].cells);
  for (const name of ['operation', 'candidate_id']) if (columns[name] === undefined) {
    return { state: sanitizeConversionDictionaryState(current), accepted: 0, rejected: [{ line: parsed.rows[0].line, reason: `${name}列がありません` }], total: 0 };
  }
  const next = sanitizeConversionDictionaryState(mode === 'replace' ? emptyConversionDictionaryState() : current);
  const rejected = [];
  let accepted = 0;
  const definitions = new Map();
  const readCandidate = (id) => next.additions[id] ?? knownCandidateById(id);
  const normalizedDefinition = (candidate) => candidate ? {
    label: cleanLabel(candidate.label), latex: cleanLatex(candidate.latex), basePriority: cleanPriority(candidate.basePriority),
  } : null;
  for (const record of parsed.rows.slice(1)) {
    if (record.cells.every((cell) => !String(cell).trim())) continue;
    const version = csvValue(record.cells, columns, 'version');
    const operation = normalizeOperation(csvValue(record.cells, columns, 'operation'));
    const id = candidateId(csvValue(record.cells, columns, 'candidate_id'));
    const reading = cleanReading(csvValue(record.cells, columns, 'reading'));
    if (version && version !== String(CONVERSION_DICTIONARY_VERSION)) { rejected.push({ line: record.line, reason: '対応していないversionです' }); continue; }
    if (!operation || !id) { rejected.push({ line: record.line, reason: 'operationまたはcandidate_idが不正です' }); continue; }
    if (operation === 'delete') {
      if (reading) {
        const aliases = new Set(next.deletedAliases[id] ?? []); aliases.add(reading); next.deletedAliases[id] = [...aliases];
      } else if (readCandidate(id)) {
        next.deletedCandidates = [...new Set([...next.deletedCandidates, id])];
      } else { rejected.push({ line: record.line, reason: '削除する候補がありません' }); continue; }
      accepted += 1; continue;
    }
    const label = cleanLabel(csvValue(record.cells, columns, 'symbol'));
    const latex = cleanLatex(csvValue(record.cells, columns, 'latex'));
    const basePriority = cleanPriority(csvValue(record.cells, columns, 'base_priority'));
    if (!label || !latex || !reading || basePriority === null) { rejected.push({ line: record.line, reason: 'upsertにはsymbol・latex・reading・base_priorityが必要です' }); continue; }
    const known = readCandidate(id);
    const defined = definitions.get(id) ?? normalizedDefinition(known);
    if (defined && (defined.label !== label || defined.latex !== latex || defined.basePriority !== basePriority)) { rejected.push({ line: record.line, reason: '同じcandidate_idのsymbol・latex・base_priorityは一致させてください' }); continue; }
    if (!known) {
      if (!next.additions[id] && Object.keys(next.additions).length >= CONVERSION_DICTIONARY_LIMITS.maxCustomCandidates) { rejected.push({ line: record.line, reason: 'カスタム候補は300件までです' }); continue; }
      next.additions[id] ??= { id, label, latex, basePriority, aliases: [] };
      definitions.set(id, next.additions[id]);
    }
    // 同じ読みをupsertしたら、既定/カスタムを問わず該当する削除墓標を外す。
    // これがないと一度消したcustom aliasをCSVで復活できない。
    const tombstones = new Set(next.deletedAliases[id] ?? []);
    for (const alias of [...tombstones]) if (normalizeConversionQuery(alias) === normalizeConversionQuery(reading)) tombstones.delete(alias);
    if (tombstones.size) next.deletedAliases[id] = [...tombstones]; else delete next.deletedAliases[id];
    if (known && knownCandidateById(id)) {
      const defaults = defaultCandidateById(id)?.aliases;
      if (!defaults?.some((alias) => normalizeConversionQuery(alias) === normalizeConversionQuery(reading))) {
        const additions = new Set(next.addedAliases[id] ?? []);
        additions.add(reading);
        next.addedAliases[id] = [...additions];
      }
    } else {
      const addition = next.additions[id];
      if (!addition.aliases.some((alias) => normalizeConversionQuery(alias) === normalizeConversionQuery(reading))) addition.aliases.push(reading);
    }
    next.deletedCandidates = next.deletedCandidates.filter((candidate) => candidate !== id);
    accepted += 1;
  }
  return { state: sanitizeConversionDictionaryState(next), accepted, rejected, total: Math.max(0, parsed.rows.length - 1) };
}

function katakanaToHiragana(text) {
  return [...text].map((char) => {
    const code = char.codePointAt(0);
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : char;
  }).join('');
}

/** 日本語IME、全角、カタカナの表記ゆれを一つの検索語へ寄せる。 */
export function normalizeConversionQuery(value) {
  const compact = katakanaToHiragana(String(value ?? '').normalize('NFKC').toLowerCase())
    .replace(/[\s　・,，.。!！?？'"`~〜ー_-]/g, '');
  return compact;
}

function cloneObject(value) {
  return JSON.parse(JSON.stringify(value));
}

export function emptyLearningState() {
  return { version: 1, selections: {} };
}

export function emptyManualPriorityState() {
  return { version: 1, priorities: {} };
}

export function sanitizeLearningState(value, candidates = CONVERSION_CANDIDATES) {
  if (!value || typeof value !== 'object' || typeof value.selections !== 'object') return emptyLearningState();
  const state = emptyLearningState();
  for (const [query, entries] of Object.entries(value.selections)) {
    if (!query || !entries || typeof entries !== 'object') continue;
    state.selections[query] = {};
    for (const [id, entry] of Object.entries(entries)) {
      if (!candidates.some((candidate) => candidate.id === id) || !entry || typeof entry !== 'object') continue;
      state.selections[query][id] = {
        count: Math.max(0, Number(entry.count) || 0),
        lastUsed: Math.max(0, Number(entry.lastUsed) || 0),
      };
    }
  }
  return state;
}

export function sanitizeManualPriorityState(value, candidates = CONVERSION_CANDIDATES) {
  if (!value || typeof value !== 'object' || typeof value.priorities !== 'object') return emptyManualPriorityState();
  const state = emptyManualPriorityState();
  for (const [id, priority] of Object.entries(value.priorities)) {
    if (!candidates.some((candidate) => candidate.id === id)) continue;
    const numeric = Number(priority);
    if (Number.isFinite(numeric) && numeric !== 0) state.priorities[id] = numeric;
  }
  return state;
}

export function recordCandidateSelection(learning, query, candidateId, now = Date.now(), candidates = CONVERSION_CANDIDATES) {
  const normalized = normalizeConversionQuery(query);
  const next = sanitizeLearningState(cloneObject(learning), candidates);
  if (!normalized || !candidates.some((candidate) => candidate.id === candidateId)) return next;
  const perQuery = next.selections[normalized] ?? (next.selections[normalized] = {});
  const previous = perQuery[candidateId] ?? { count: 0, lastUsed: 0 };
  const timestamp = Math.max(0, Number(now) || 0);
  // 学習は同じ候補を延々と選んでも無限に強くしない。約90日で半分へ戻し、
  // 最近の使い方だけがゆるく残るようにする。
  const elapsedDays = previous.lastUsed ? Math.max(0, (timestamp - previous.lastUsed) / 86400000) : 0;
  const decayed = Math.max(0, previous.count * Math.pow(0.5, elapsedDays / 90));
  perQuery[candidateId] = { count: Math.min(200, decayed + 1), lastUsed: timestamp };
  return next;
}

export function setManualPriority(manual, candidateId, priority, candidates = CONVERSION_CANDIDATES) {
  const next = sanitizeManualPriorityState(cloneObject(manual), candidates);
  if (!candidates.some((candidate) => candidate.id === candidateId)) return next;
  const numeric = Math.trunc(Number(priority) || 0);
  if (numeric === 0) delete next.priorities[candidateId];
  else next.priorities[candidateId] = Math.max(-50, Math.min(50, numeric));
  return next;
}

export function resetManualPriorities() {
  return emptyManualPriorityState();
}

function matchCandidate(candidate, query) {
  let strongest = 0;
  for (const rawAlias of candidate.aliases) {
    const alias = normalizeConversionQuery(rawAlias);
    if (!alias) continue;
    if (alias === query) strongest = Math.max(strongest, 3000);
    else if (alias.startsWith(query)) strongest = Math.max(strongest, 2000 + Math.min(600, query.length * 30));
  }
  return strongest;
}

/**
 * 優先順: 手動順位 > 読みの一致種別 > 初期プリセット > 選択履歴/最近使った順。
 * 手動順位は学習より必ず強い。選択履歴は上限と時間減衰を持つ補助情報に留める。
 */
export function rankConversionCandidates(query, learning = emptyLearningState(), manual = emptyManualPriorityState(), now = Date.now(), limit = 8, candidates = CONVERSION_CANDIDATES) {
  const normalized = normalizeConversionQuery(query);
  if (!normalized) return [];
  const safeLearning = sanitizeLearningState(learning, candidates);
  const safeManual = sanitizeManualPriorityState(manual, candidates);
  const perQuery = safeLearning.selections[normalized] ?? {};
  return candidates
    .map((candidate) => {
      const match = matchCandidate(candidate, normalized);
      if (!match) return null;
      const learned = perQuery[candidate.id] ?? { count: 0, lastUsed: 0 };
      const ageHours = learned.lastUsed ? Math.max(0, (Number(now) - learned.lastUsed) / 3600000) : Infinity;
      const recency = Number.isFinite(ageHours) ? Math.max(0, 80 - Math.min(80, ageHours / 3)) : 0;
      const elapsedDays = learned.lastUsed ? Math.max(0, (Number(now) - learned.lastUsed) / 86400000) : 0;
      const learnedScore = Math.min(200, learned.count) * Math.pow(0.5, elapsedDays / 90) * 30 + recency;
      return {
        ...candidate,
        query: normalized,
        match,
        score: match + candidate.basePriority + learnedScore,
        learnedCount: learned.count,
        manualPriority: safeManual.priorities[candidate.id] ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.manualPriority - a.manualPriority || b.score - a.score || b.basePriority - a.basePriority || a.label.localeCompare(b.label, 'ja'))
    .slice(0, limit);
}

export function getConversionCandidate(candidateId, candidates = CONVERSION_CANDIDATES) {
  return candidates.find((candidate) => candidate.id === candidateId) ?? null;
}
