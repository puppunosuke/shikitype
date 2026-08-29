// Tabで symbol -> latin -> greek を循環し、Shiftは英字/ギリシャ文字だけを大文字化する。
// 物理キー（event.code）で定義し、JIS/US配列に依存しない。
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

const SYMBOLS = {
  KeyF: { type: 'open', kind: 'paren' }, KeyJ: { type: 'afrac' },
  KeyG: { type: 'op', symbol: '+' }, KeyH: { type: 'op', symbol: '-' },
  KeyD: { type: 'open', kind: 'sup' }, KeyK: { type: 'open', kind: 'sub' },
  KeyS: { type: 'op', symbol: '=' }, KeyL: { type: 'nfrac' },
  KeyA: { type: 'open', kind: 'sqrt' },
  // Semicolon（絶対値）は2026-08-30 拓男指定で撤去（音声指摘2件目）。「セミコロンの
  // キーを押したら絶対値が発動するのがキモい」という理由で、素キーからは完全に外す。
  // 絶対値そのものは (1) サイドバーのキー割当設定（ASSIGNABLE、app.js）から任意の
  // キーへ割り当て直せる (2) 変換方式の読み「ぜったいち」（conversion.jsのid:absolute→
  // app.jsのBUILTIN_CONVERSION_ACTIONS）から出せる、の2経路を残したので、消しても
  // 絶対値そのものが打てなくなるわけではない。
  KeyQ: { type: 'term-literal', latex: '\\,dx' }, KeyW: { type: 'literal', latex: '\\frac{d}{dx}' },
  KeyE: { type: 'term-literal', latex: 'e' }, KeyR: { type: 'term-literal', latex: '\\to ' },
  KeyT: { type: 'literal', latex: '\\cdot ' }, KeyY: { type: 'lim' },
  KeyU: { type: 'literal', latex: '\\int ' }, KeyI: { type: 'term-literal', latex: 'i' },
  KeyO: { type: 'sum' }, KeyP: { type: 'term-literal', latex: '\\pi ' },
  KeyZ: { type: 'literal', latex: '\\leqq ' }, KeyX: { type: 'literal', latex: '\\geqq ' },
  KeyC: { type: 'literal', latex: '\\ne ' }, KeyV: { type: 'func', name: 'sin' },
  KeyB: { type: 'func', name: 'cos' }, KeyN: { type: 'func', name: 'tan' },
  KeyM: { type: 'func', name: 'log' }, Comma: { type: 'literal', latex: ',' },
  Period: { type: 'literal', latex: '.' }, Slash: { type: 'term-literal', latex: '\\infty ' },
};

const DIGITS = {};
for (let d = 0; d <= 9; d++) DIGITS['Digit' + d] = { type: 'digit', value: String(d) };

// 高校数学 全範囲の科目→単元。単元プリセットが切り替えるのはキーガイドの表示だけで、
// キー割り当て（SYMBOLS/GREEK_BY_CODEなど）はここでは一切動かさない。
export const SUBJECTS = [
  { id: 's1', label: '数I', units: [
    { id: 's1-suushiki', label: '数と式' },
    { id: 's1-shugo', label: '集合と命題' },
    { id: 's1-nijikansu', label: '2次関数' },
    { id: 's1-keiryo', label: '図形と計量' },
    { id: 's1-data', label: 'データの分析' },
  ] },
  { id: 'sa', label: '数A', units: [
    { id: 'sa-kakuritsu', label: '場合の数と確率' },
    { id: 'sa-zukei', label: '図形の性質' },
    { id: 'sa-seisuu', label: '整数の性質' },
  ] },
  { id: 's2', label: '数II', units: [
    { id: 's2-shomei', label: '式と証明' },
    { id: 's2-fukusosu', label: '複素数と方程式' },
    { id: 's2-zukeihoteishiki', label: '図形と方程式' },
    { id: 's2-sankaku', label: '三角関数' },
    { id: 's2-shisutaisu', label: '指数関数・対数関数' },
    { id: 's2-bibunsekibun', label: '微分積分' },
  ] },
  { id: 'sb', label: '数B', units: [
    { id: 'sb-suuretsu', label: '数列' },
    { id: 'sb-suisoku', label: '統計的な推測' },
  ] },
  { id: 'sc', label: '数C', units: [
    { id: 'sc-vector', label: 'ベクトル' },
    { id: 'sc-kyokusen', label: '平面上の曲線と複素数平面' },
  ] },
  { id: 's3', label: '数III', units: [
    { id: 's3-kyokugen', label: '極限' },
    { id: 's3-bibun', label: '微分法' },
    { id: 's3-sekibun', label: '積分法' },
  ] },
];
export const UNITS = SUBJECTS.flatMap((s) => s.units.map((u) => ({ ...u, subject: s.id, subjectLabel: s.label })));
// 単元を絞らず高校数学の全範囲を使うためのプリセット。個別単元と同じくノートへ
// 保存できるIDにし、あとから開いてもガイドの状態がぶれないようにする。
export const ALL_UNITS_ID = 'all';

// キーごとの単元タグ。'common' は常に強調（全単元で使う）。配列は「そのキーの記号が
// よく使われる単元」の一覧で、現在単元がどれにも含まれなければキーガイドで薄く表示する
// （out-of-unit）。キー自体は消さない・動かさない。
export const unitTags = {
  KeyF: 'common', KeyJ: 'common', KeyG: 'common', KeyH: 'common', KeyD: 'common',
  KeyK: 'common', KeyS: 'common', KeyL: 'common', KeyA: 'common',
  KeyQ: ['s2-bibunsekibun', 's3-sekibun'], KeyW: ['s2-bibunsekibun', 's3-bibun'],
  KeyE: ['s2-shisutaisu', 's3-bibun', 's3-sekibun'], KeyR: ['s3-kyokugen', 'sb-suuretsu'],
  KeyT: 'common',
  KeyY: ['s3-kyokugen'], KeyU: ['s2-bibunsekibun', 's3-sekibun'], KeyI: 'common',
  KeyO: ['sb-suuretsu', 's3-sekibun'], KeyP: 'common',
  KeyZ: 'common', KeyX: 'common', KeyC: 'common',
  KeyV: ['s1-keiryo', 's2-sankaku', 's3-bibun'], KeyB: ['s1-keiryo', 's2-sankaku', 's3-bibun'],
  KeyN: ['s1-keiryo', 's2-sankaku', 's3-bibun'], KeyM: ['s2-shisutaisu', 's3-bibun'],
  Comma: 'common', Period: 'common', Slash: ['s3-kyokugen', 'sb-suuretsu'],
};

/** キー code の記号が unit（単元id）でよく使われるか（'common' またはタグ配列に含む）。 */
export function isKeyInUnit(code, unit) {
  if (unit === ALL_UNITS_ID) return true;
  const tag = unitTags[code];
  if (!tag || tag === 'common') return true;
  if (Array.isArray(tag)) return tag.includes(unit);
  return tag === unit;
}

const SYMBOL_LABELS = {
  KeyF: '(…)', KeyJ: 'α/n', KeyG: '+', KeyH: '-', KeyD: '^', KeyK: '_',
  KeyS: '=', KeyL: 'n/α', KeyA: '√', KeyQ: 'dx', KeyW: 'd/dx',
  KeyE: 'e', KeyR: '→', KeyT: '·', KeyY: 'lim', KeyU: '∫', KeyI: 'i',
  KeyO: 'Σ', KeyP: 'π', KeyZ: '≦', KeyX: '≧', KeyC: '≠', KeyV: 'sin',
  KeyB: 'cos', KeyN: 'tan', KeyM: 'log', Comma: ',', Period: '.', Slash: '∞',
};

export const physicalRows = [
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
];

const KEY_DISPLAY_OVERRIDES = { Semicolon: ';', Comma: ',', Period: '.', Slash: '/' };
export function keyDisplayName(code) {
  return KEY_DISPLAY_OVERRIDES[code] ?? code.replace('Key', '').replace('Digit', '');
}

function buildLatinLayer() {
  const layer = {};
  for (const letter of LETTERS) layer['Key' + letter.toUpperCase()] = { type: 'variable', letter };
  return { ...layer, ...DIGITS };
}

// 綴りに近い英字へ置く24文字の固定配置。J/Vは未割り当て。
const GREEK_BY_CODE = {
  KeyA: ['α', 'Α', '\\alpha ', 'A'], KeyB: ['β', 'Β', '\\beta ', 'B'],
  KeyG: ['γ', 'Γ', '\\gamma ', '\\Gamma '], KeyD: ['δ', 'Δ', '\\delta ', '\\Delta '],
  KeyE: ['ε', 'Ε', '\\epsilon ', 'E'], KeyZ: ['ζ', 'Ζ', '\\zeta ', 'Z'],
  KeyH: ['η', 'Η', '\\eta ', 'H'], KeyQ: ['θ', 'Θ', '\\theta ', '\\Theta '],
  KeyI: ['ι', 'Ι', '\\iota ', 'I'], KeyK: ['κ', 'Κ', '\\kappa ', 'K'],
  KeyL: ['λ', 'Λ', '\\lambda ', '\\Lambda '], KeyM: ['μ', 'Μ', '\\mu ', 'M'],
  KeyN: ['ν', 'Ν', '\\nu ', 'N'], KeyX: ['ξ', 'Ξ', '\\xi ', '\\Xi '],
  KeyO: ['ο', 'Ο', 'o', 'O'], KeyP: ['π', 'Π', '\\pi ', '\\Pi '],
  KeyR: ['ρ', 'Ρ', '\\rho ', 'P'], KeyS: ['σ', 'Σ', '\\sigma ', '\\Sigma '],
  KeyT: ['τ', 'Τ', '\\tau ', 'T'], KeyU: ['υ', 'Υ', '\\upsilon ', '\\Upsilon '],
  KeyF: ['φ', 'Φ', '\\phi ', '\\Phi '], KeyC: ['χ', 'Χ', '\\chi ', 'X'],
  KeyY: ['ψ', 'Ψ', '\\psi ', '\\Psi '], KeyW: ['ω', 'Ω', '\\omega ', '\\Omega '],
};

function buildGreekLayer() {
  const layer = { ...DIGITS };
  for (const [code, [lowerLabel, upperLabel, lowerLatex, upperLatex]] of Object.entries(GREEK_BY_CODE)) {
    layer[code] = { type: 'greek', lowerLabel, upperLabel, lowerLatex, upperLatex };
  }
  return layer;
}

export const LAYERS = ['symbol', 'latin', 'greek'];
export const LAYER_NAMES = { symbol: '記号', latin: '英字', greek: 'ギリシャ' };
export const layerMap = {
  id: 'TAB', label: 'Tabで 記号 / 英字 / ギリシャ文字 を切り替え',
  symbol: { ...SYMBOLS, ...DIGITS }, latin: buildLatinLayer(), greek: buildGreekLayer(),
};
export const layouts = { TAB: layerMap };
export function getActiveLayout() { return layerMap; }
export function setActiveLayout(layoutOrId) {
  if (layoutOrId !== layerMap && layoutOrId !== 'TAB') throw new Error('unknown layout: ' + layoutOrId);
  return layerMap;
}

const OVERRIDES_KEY = 'neo-math.keymap-overrides.v2';
let overrides = {};
try { overrides = JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}'); }
catch { overrides = {}; }
function saveOverrides() {
  try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides)); }
  catch (err) { console.warn('[neo-math] keymap override save failed', err); }
}
export function getOverride(code, layer) { return overrides[layer]?.[code] ?? null; }
export function setOverride(code, layer, action, label) {
  if (!LAYERS.includes(layer)) throw new Error('unknown layer: ' + layer);
  overrides[layer] ??= {};
  overrides[layer][code] = { action, label };
  saveOverrides();
}
export function clearOverride(code, layer) { if (overrides[layer]) delete overrides[layer][code]; saveOverrides(); }
export function clearAllOverrides() { overrides = {}; saveOverrides(); }
export function overrideCount() {
  return LAYERS.reduce((count, layer) => count + Object.keys(overrides[layer] ?? {}).length, 0);
}

function withUppercase(action, uppercase) {
  if (!action || !uppercase) return action;
  if (action.type === 'variable') return { ...action, letter: action.letter.toUpperCase() };
  if (action.type === 'greek') return { type: 'greek', latex: action.upperLatex, label: action.upperLabel };
  return action;
}
export function actionFor(code, layer, uppercase = false) {
  const action = getOverride(code, layer)?.action ?? layerMap[layer]?.[code] ?? null;
  if (action?.type === 'greek' && !uppercase) return { type: 'greek', latex: action.lowerLatex, label: action.lowerLabel };
  return withUppercase(action, uppercase);
}
export function labelFor(code, layer, uppercase = false) {
  const override = getOverride(code, layer);
  if (override) {
    const action = withUppercase(override.action, uppercase);
    if (action.type === 'variable') return action.letter;
    if (action.type === 'greek') return action.label ?? override.label;
    return override.label;
  }
  const action = actionFor(code, layer, uppercase);
  if (!action) return null;
  if (action.type === 'variable') return action.letter;
  if (action.type === 'greek') return action.label;
  if (action.type === 'digit') return action.value;
  return SYMBOL_LABELS[code] ?? null;
}
export function resolveAction(code, layer = 'symbol', shiftKey = false) {
  return actionFor(code, layer, shiftKey && layer !== 'symbol');
}
