// NEO Math Solution — Pass 1 入力コア
// 仕様: aineo-math-solution.md (B5E1) / aineo-math-solution-keymap.md (6C19) / aineo-math-solution-mvp.md (A2E5)
//
// 設計の要点（3F7B の実測を踏襲）:
// - 自前のステートマシン（スロットスタック）が唯一の権威。MathLive の getElementInfo().depth はズレ検知にのみ使う。
// - スロットを1段閉じる = executeCommand('moveAfterParent')。多スロット構造（分数）の途中送りは moveToNextPlaceholder。
// - キー入力は document への capture フェーズ keydown で完全に横取りする。
// - IME は数式ブロックで遮断する（Pass1はブロックが数式のみなので常時遮断）。

import '/vendor/mathlive.min.mjs';
// 設定ドロワー内の通常コントロール操作を、数式欄のフォーカス復帰が奪わないようにする。
MathfieldElement.restoreFocusWhenDocumentFocused = false;
import {
  resolveAction, getActiveLayout, physicalRows, keyDisplayName,
  LAYERS, LAYER_NAMES, labelFor, actionFor, getOverride, setOverride, clearOverride, clearAllOverrides, overrideCount,
  SUBJECTS, UNITS, ALL_UNITS_ID, isKeyInUnit,
} from '/keymap.js';
import { convertUnicodeToLatex } from '/unicode-latex.js';
import {
  rankConversionCandidates, recordCandidateSelection, sanitizeLearningState,
  sanitizeManualPriorityState, setManualPriority, resetManualPriorities,
  getConversionCandidate, normalizeConversionQuery, convertShikitypeReading,
  emptyConversionDictionaryState, sanitizeConversionDictionaryState, effectiveConversionCandidates,
  importConversionDictionaryCsv, exportConversionDictionaryCsv,
} from '/conversion.js';
import { createDictionaryTablePanel } from '/dictionary-table.js';

// ---------------------------------------------------------------------------
// セッション統計（51D3 の速度実測用: 打鍵数と経過時間）
// ---------------------------------------------------------------------------
const stats = {
  keystrokes: 0,
  startTime: performance.now(),
};
window.__neoStats = stats;

const INPUT_METHOD_KEY = 'neo-math.input-method.v1';
const INPUT_SYSTEM_KEY = 'neo-math.input-system.v1';
const LAYER_INPUT_METHOD_KEY = 'neo-math.layer-input-method.v1';
const CONVERSION_LEARNING_KEY = 'neo-math.conversion-learning.v1';
const CONVERSION_MANUAL_PRIORITY_KEY = 'neo-math.conversion-manual-priority.v1';
const CONVERSION_DICTIONARY_KEY = 'neo-math.conversion-dictionary.v1';
const CONVERSION_PROFILE_REVISION_KEY = 'neo-math.conversion-profile-revision.v1';
const CONVERSION_PROFILE_META_KEY = 'neo-math.conversion-profile-meta.v1';
const KEY_CAPTURE_KEY = 'neo-math.key-capture.v1';
const LONG_PRESS_MS = 430;
const INPUT_METHODS = {
  toggle: {
    name: '標準', defaultLayer: 'symbol',
    note: 'Tabで記号・英字・ギリシャ文字を固定切替します。',
  },
  math: {
    name: '数式常駐', defaultLayer: 'latin',
    note: '英字層を主面にし、頻出する演算・構造記号を常時表示します。',
  },
  hybrid: {
    name: '一時＋固定', defaultLayer: 'symbol',
    note: 'Tabは次の1入力だけ切替。「固定」で同じ層を続けて使えます。',
  },
  hold: {
    name: '長押し', defaultLayer: 'latin',
    note: '短押しは文字、430msの長押しは同じキーの記号を入力します。',
  },
};
const INPUT_SYSTEMS = {
  legacy: { name: '従来方式', note: 'これまでどおり、4種類の入力方法とキーの層を使います。' },
  conversion: { name: 'SHIKITYPE変換方式', note: '変換用の層では、英字・かなを読みとして受け取り、候補を確定したときだけ式へ入れます。' },
};
let inputSystem = 'legacy';
try {
  const savedSystem = localStorage.getItem(INPUT_SYSTEM_KEY);
  if (INPUT_SYSTEMS[savedSystem]) inputSystem = savedSystem;
} catch { /* 保存不可でも従来方式で続行する */ }
let inputMethod = 'toggle';
try {
  const savedMethod = localStorage.getItem(INPUT_METHOD_KEY);
  if (INPUT_METHODS[savedMethod]) inputMethod = savedMethod;
} catch { /* 保存不可でも標準方式で続行する */ }
let legacyInputMethod = inputMethod;

// 既存の入力方式は「3層へまとめて適用するプリセット」としてそのまま残す。
// 新しい保存値が無い既存利用者は、最後に選んだ方式を全層へ複製してから始めるので
// 旧localStorage値を失わない。
const INPUT_METHOD_LAYERS = ['conversion', 'latin', 'greek'];
let layerInputMethods = Object.fromEntries(INPUT_METHOD_LAYERS.map((layer) => [layer, inputMethod]));
try {
  const savedLayerMethods = JSON.parse(localStorage.getItem(LAYER_INPUT_METHOD_KEY) || 'null');
  if (savedLayerMethods && typeof savedLayerMethods === 'object') {
    for (const layer of INPUT_METHOD_LAYERS) {
      if (INPUT_METHODS[savedLayerMethods[layer]]) layerInputMethods[layer] = savedLayerMethods[layer];
    }
  }
} catch { /* 旧値または壊れた値は従来のプリセットから復元する */ }
let conversionDictionary = emptyConversionDictionaryState();
try { conversionDictionary = sanitizeConversionDictionaryState(JSON.parse(localStorage.getItem(CONVERSION_DICTIONARY_KEY) || 'null')); }
catch { /* 辞書保存値が壊れても既定辞書だけで続ける */ }
function activeConversionCandidates() { return effectiveConversionCandidates(conversionDictionary); }
let conversionLearning = sanitizeLearningState(null, activeConversionCandidates());
let conversionManualPriority = sanitizeManualPriorityState(null, activeConversionCandidates());
try { conversionLearning = sanitizeLearningState(JSON.parse(localStorage.getItem(CONVERSION_LEARNING_KEY) || 'null'), activeConversionCandidates()); }
catch { /* 学習履歴が壊れても入力そのものは止めない */ }
try { conversionManualPriority = sanitizeManualPriorityState(JSON.parse(localStorage.getItem(CONVERSION_MANUAL_PRIORITY_KEY) || 'null'), activeConversionCandidates()); }
catch { /* 手動順位が壊れても初期プリセットで続ける */ }

function saveLayerInputMethods() {
  try { localStorage.setItem(LAYER_INPUT_METHOD_KEY, JSON.stringify(layerInputMethods)); }
  catch (err) { console.warn('[neo-math] layer input method save failed', err); }
}
function saveConversionPreferences({ profileChange = false } = {}) {
  try {
    localStorage.setItem(conversionProfileStorageKey(CONVERSION_LEARNING_KEY), JSON.stringify(conversionLearning));
    localStorage.setItem(conversionProfileStorageKey(CONVERSION_MANUAL_PRIORITY_KEY), JSON.stringify(conversionManualPriority));
  } catch (err) { console.warn('[neo-math] conversion preference save failed', err); }
  if (profileChange) markConversionProfileDirty();
}
function saveConversionDictionary() {
  try { localStorage.setItem(conversionProfileStorageKey(CONVERSION_DICTIONARY_KEY), JSON.stringify(conversionDictionary)); }
  catch (err) { console.warn('[neo-math] conversion dictionary save failed', err); }
  markConversionProfileDirty();
}
function applyConversionDictionary(nextDictionary, { persist = true } = {}) {
  conversionDictionary = sanitizeConversionDictionaryState(nextDictionary);
  const candidates = activeConversionCandidates();
  conversionLearning = sanitizeLearningState(conversionLearning, candidates);
  conversionManualPriority = sanitizeManualPriorityState(conversionManualPriority, candidates);
  if (persist) { saveConversionDictionary(); saveConversionPreferences(); }
  for (const row of rows ?? []) if (row.conversion) renderConversionCandidates(row);
  renderConversionPriorityControls();
}
function logicalLayerForMethod(layer) { return layer === 'symbol' ? 'conversion' : layer; }
function inputMethodForLayer(layer) {
  return inputSystem === 'conversion'
    ? (layerInputMethods[logicalLayerForMethod(layer)] ?? inputMethod)
    : inputMethod;
}
function setLayerInputMethod(layer, methodId) {
  if (!INPUT_METHOD_LAYERS.includes(layer) || !INPUT_METHODS[methodId]) return;
  layerInputMethods[layer] = methodId;
  saveLayerInputMethods();
  if (inputSystem === 'conversion' && logicalLayerForMethod(activeInputLayer()) === layer) {
    cancelPhysicalLongPress();
    inputMethod = methodId;
    virtualShift = false;
    updateInputMethodUI();
    renderKeyGuide();
    if (isShikitypeTransformLayer()) openConversion(activeRow(), true);
  }
}
let temporaryLayer = null;
// 一時遷移の判定は「到着した層の方式」ではなく、移動を開始した層の方式に属する。
// これを分けないと conversion=hybrid → latin=toggle のような組合せで戻れない。
let temporaryTransition = null;
let physicalLongPress = null;

// 方式ごとの起動時の基底層（'symbol' か 'latin'）。既定値は現行の挙動を維持する
// （記号が基底、長押しのみ短押し=英字/長押し=記号）。方式ごとに独立して保存する。
const METHOD_BASE_KEY = 'neo-math.method-base-layer.v1';
const METHOD_BASE_DEFAULTS = { toggle: 'symbol', math: 'latin', hybrid: 'symbol', hold: 'latin' };
let methodBaseLayer = { ...METHOD_BASE_DEFAULTS };
try {
  const savedBase = JSON.parse(localStorage.getItem(METHOD_BASE_KEY) || '{}');
  for (const id of Object.keys(METHOD_BASE_DEFAULTS)) {
    if (savedBase[id] === 'symbol' || savedBase[id] === 'latin') methodBaseLayer[id] = savedBase[id];
  }
} catch { /* 保存不可でも既定値で続行する */ }
function saveMethodBaseLayer() {
  try { localStorage.setItem(METHOD_BASE_KEY, JSON.stringify(methodBaseLayer)); }
  catch (err) { console.warn('[neo-math] method base layer save failed', err); }
}
function setMethodBaseLayer(methodId, layer) {
  if (!METHOD_BASE_DEFAULTS[methodId] || (layer !== 'symbol' && layer !== 'latin')) return;
  methodBaseLayer[methodId] = layer;
  saveMethodBaseLayer();
  if (inputMethod === methodId) {
    if (methodId === 'hold') {
      // holdはbaseLayerが常に英字⇔ギリシャの状態を保持する変数なので、ここでは
      // 触らない（symbolになっていた場合だけ保険でlatinへ戻す）。短押し/長押しの
      // 入れ替えはholdShortLayer/holdLongLayerがmethodBaseLayer.holdを見て決める。
      if (baseLayer === 'symbol') baseLayer = 'latin';
    } else {
      baseLayer = layer;
    }
    temporaryLayer = null;
    temporaryTransition = null;
    virtualShift = false;
    renderKeyGuide();
  }
}
// 長押し方式で「短押し=記号」に入れ替えられているか。入れ替え時は
// 短押し=記号・長押し=英字/ギリシャ（baseLayerがそのままlatin/greek切替の状態を保持する）になる。
function holdShortLayer() { return methodBaseLayer.hold === 'symbol' ? 'symbol' : baseLayer; }
function holdLongLayer() { return methodBaseLayer.hold === 'symbol' ? baseLayer : 'symbol'; }

// キー操作モード: 'accessible' は F2/F4/F8/F9 で画面操作へ届く。'original' は従来どおり全キーを数式欄が奪う。
const KEY_CAPTURE_MODES = { accessible: true, original: true };
let keyCaptureMode = 'accessible';
try {
  const savedMode = localStorage.getItem(KEY_CAPTURE_KEY);
  if (KEY_CAPTURE_MODES[savedMode]) keyCaptureMode = savedMode;
} catch { /* 保存不可でも既定（accessible）で続行する */ }

function renderElapsed() {
  const elapsedEl = document.getElementById('stat-elapsed');
  if (elapsedEl) elapsedEl.textContent = ((performance.now() - stats.startTime) / 1000).toFixed(1) + 's';
}

// 経過時間は打鍵時だけでなく常時進む。止まってる時間が消えると速度実測（51D3）が過大評価になるため。
setInterval(renderElapsed, 200);

function tickKeystroke() {
  stats.keystrokes += 1;
  const el = document.getElementById('stat-keystrokes');
  if (el) el.textContent = String(stats.keystrokes);
  renderElapsed();
}

function saveSessionLog() {
  try {
    const key = 'neo-math-session-log';
    const log = JSON.parse(localStorage.getItem(key) || '[]');
    log.push({
      keystrokes: stats.keystrokes,
      elapsedMs: performance.now() - stats.startTime,
      layout: getActiveLayout().id,
      inputMethod,
      timestamp: new Date().toISOString(),
    });
    localStorage.setItem(key, JSON.stringify(log));
  } catch (e) {
    console.warn('[neo-math] failed to save session log', e);
  }
}
window.addEventListener('beforeunload', saveSessionLog);
window.__neoSaveSessionLog = saveSessionLog;

// ---------------------------------------------------------------------------
// RowState — 1つの math-field（式行）につき1個。スロットスタックと項ラン（term run）を持つ。
// ---------------------------------------------------------------------------

let rowCounter = 0;

class RowState {
  constructor(mf, id = null) {
    this.id = isBlockId(id) ? id : makeBlockId();
    this.mf = mf;
    this.stack = [];       // 開いているスロットのスタック（自前の権威）
    this.history = [];     // Shift+Space で1段開き直すための履歴
    this.run = [];         // 現在アクティブなレベルの「項ラン」（直前の項判定に使う）
    this.runStack = [];    // 親レベルの run を退避するスタック（stack と対応）
    // 矢印で一時的に外へ出た、自分で開いた構造。復元LaTeX由来のunknownと区別し、
    // 空のまま戻った構造をBackspaceで正しく取り消すためだけに短時間保持する。
    this.detachedFrames = [];
    // \text{}をこのアプリの「文」キーで開いた間だけ真。MathLiveのmodeやdepthは
    // focus/placeholderのタイミングで揺れるため、capture中のIME境界には使わない。
    this.nativeTextOpen = false;
  }
}

const rows = []; // RowState[]（今のところブロックは1つ、行の配列）
let activeRowIndex = 0;
// ノート切替はローカル復元→クラウド復元のように連続して起こり得る。古いrAFが
// 既に破棄したMathLiveへフォーカスしないよう、最後の復元だけを有効にする。
let restoreFocusFrame = 0;
let restoreFocusTimer = 0;
// アカウントdialog中に数式欄を破棄すると、MathLiveの古いfocusセッションが
// 次の欄のfocus時まで残る。閉じるまで表示面の差し替えを遅らせる。
let pendingEditorRefresh = false;
// 画面キーのclick前に古いfocus rAFがactiveRowIndexを戻しても、文の編集対象は
// 明示的に閉じるまで保つ。
let nativeTextRow = null;
// MathLiveは新しいfieldをmountした直後、直前fieldのkeyboard sinkへ非同期で
// focusを戻すことがある。その一回だけの古いfocusinでactive rowを奪わせず、
// 明示した入力先を二フレーム後に再確定するための短い保護領域。
let rowFocusClaim = 0;
let protectedFocusRow = null;

function activeRow() { return rows[activeRowIndex]; }

function claimRowFocus(row) {
  const index = rows.indexOf(row);
  if (index < 0 || !row?.mf?.isConnected) return;
  const claim = ++rowFocusClaim;
  protectedFocusRow = row;
  activeRowIndex = index;
  focusRowInput(row);
  scheduleConversionCaret(row);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (claim !== rowFocusClaim || rows.indexOf(row) < 0 || !row.mf.isConnected) return;
    activeRowIndex = rows.indexOf(row);
    focusRowInput(row);
    scheduleConversionCaret(row);
  }));
}

// SHIKITYPE変換中の入力先は非編集proxyであり、MathLive本体の実caretは表示されない。
// 論理positionに追従する専用caretを重ね、OS IMEを起動せずに入力位置だけを示す。
function scheduleConversionCaret(row = activeRow()) {
  if (!row?.caret) return;
  // MathLive mount とcanvas transformは別フレームで確定する。最初の一回だけでは
  // 空白click直後に(0,0)へ残ることがあるため、短い安定化期間は追従を続ける。
  requestAnimationFrame(() => {
    updateConversionCaret(row);
    requestAnimationFrame(() => {
      updateConversionCaret(row);
      requestAnimationFrame(() => updateConversionCaret(row));
    });
  });
}
function updateConversionCaret(row = activeRow()) {
  // 非同期rAFが旧rowから後着しても、常に「現在の入力先」だけを描画対象にする。
  // row切替、canvas生成、復元、Backspace削除をまたいでも可視caretは最大1本に保つ。
  row = activeRow();
  for (const candidateRow of rows) {
    if (candidateRow !== row && candidateRow.caret) candidateRow.caret.hidden = true;
  }
  const caret = row?.caret;
  if (!caret) return;
  // `getElementInfo().latex` は\text{}を閉じた直後も親構造を返すことがある。
  // caretの表示可否は、実際に標準IMEを許可している状態（nativeTextOpen / text mode）で
  // 判定する。これでEnterで文を閉じた瞬間に論理caretを戻せる。
  const textEntryOpen = row?.nativeTextOpen || row?.mf?.mode === 'text';
  const visible = isShikitypeTransformLayer() && !textEntryOpen && activeRow() === row && !document.getElementById('sidebar')?.open;
  caret.hidden = !visible;
  if (!visible) return;
  const fieldRect = row.mf.getBoundingClientRect();
  let left = fieldRect.left + 4; let top = fieldRect.top + 8; let height = Math.max(22, Math.min(44, fieldRect.height - 14));
  try {
    const info = row.mf.getElementInfo(row.mf.position);
    const bounds = info?.bounds ?? info?.boundingRect ?? info?.rect;
    if (bounds && Number.isFinite(bounds.left) && layoutMode !== 'canvas') { left = bounds.left + (bounds.width || 0); top = bounds.top; height = Math.max(18, bounds.height || height); }
    else if (bounds && Number.isFinite(bounds.left) && layoutMode === 'canvas') {
      // MathLiveのboundsはcanvas transform前の座標で返る。transform後のglobal値を
      // そのまま使うと行外/0,0へ飛ぶため、同じfield内のposition=0との差分だけを
      // 実画面のfield左端へ加える。文字幅・上下付きなどの論理移動は保持する。
      const originInfo = row.mf.getElementInfo(0);
      const origin = originInfo?.bounds ?? originInfo?.boundingRect ?? originInfo?.rect;
      if (origin && Number.isFinite(origin.left)) {
        const zoom = canvasCamera.zoom;
        left = fieldRect.left + 4 + ((bounds.left + (bounds.width || 0)) - (origin.left + (origin.width || 0))) * zoom;
        top = fieldRect.top + 7 + (bounds.top - origin.top) * zoom;
        height = Math.max(18, (bounds.height || height) * zoom);
      } else {
        const fraction = Math.min(1, Math.max(0, Number(row.mf.position || 0) / Math.max(1, Number(row.mf.lastOffset || 1))));
        left = fieldRect.left + 3 + (fieldRect.width - 8) * fraction;
      }
    }
    else { const fraction = Math.min(1, Math.max(0, Number(row.mf.position || 0) / Math.max(1, Number(row.mf.lastOffset || 1)))); left = fieldRect.left + 3 + (fieldRect.width - 8) * fraction; }
  } catch { /* mount途中は次フレームで追従する */ }
  caret.style.left = `${Math.round(left)}px`; caret.style.top = `${Math.round(top)}px`; caret.style.height = `${Math.round(height)}px`;
}

// ---------------------------------------------------------------------------
// 項ラン（term run）操作: 「直前の項」判定の自前実装
// パターン: (1)直前に閉じた括弧グループ全体 (2)数字の連なり (3)変数1つ＋付いている添字 (4)関数適用1つ
// MathLive の内部DOM/クラス名には一切依存せず、自分が発行したキー操作の履歴だけで判定する。
// ---------------------------------------------------------------------------

function pushToken(row, token) {
  const run = row.run;
  // 直前が 'func' で隙間なく隣接していれば関数適用として結合（パターン4: sin x, log n）
  if (run.length && run[run.length - 1].kind === 'func' && run[run.length - 1].end === token.start) {
    const func = run.pop();
    run.push({ kind: 'funcApp', start: func.start, end: token.end });
    return;
  }
  // 数字は連続する限り1つのトークンへ伸長する（パターン2: 123, 3.14）
  if (token.kind === 'digits' && run.length && run[run.length - 1].kind === 'digits' && run[run.length - 1].end === token.start) {
    run[run.length - 1].end = token.end;
    return;
  }
  run.push(token);
}

function clearRun(row) {
  row.run = [];
}

/** 現在の run の末尾（＝直前の項）を返す。無ければ null。 */
function lastTerm(row) {
  return row.run.length ? row.run[row.run.length - 1] : null;
}

// ---------------------------------------------------------------------------
// スロットスタック操作
// ---------------------------------------------------------------------------

function snapshotForHistory(row) {
  return {
    stack: row.stack.map((f) => ({ ...f })),
    run: row.run.slice(),
    runStack: row.runStack.map((r) => r.slice()),
    position: row.mf.position,
  };
}

/** 単一スロット構造（(), sup, sub, sqrt, abs, lim, afrac）を開く共通処理 */
function openSingleSlot(row, kind, insertLatex, opts) {
  const posBefore = row.mf.position;
  const latexBefore = row.mf.value;
  let mergeTarget = null;
  if ((kind === 'sup' || kind === 'sub')) {
    const last = lastTerm(row);
    // パターン3: 直前が変数1つのときだけ、上付き/下付きはその変数へ結合する
    if (last && (last.kind === 'var') && last.end === posBefore) {
      mergeTarget = last;
    }
  }
  row.runStack.push(row.run);
  row.run = [];
  let ok;
  if (kind === 'sup') {
    ok = row.mf.executeCommand('moveToSuperscript');
  } else if (kind === 'sub') {
    ok = row.mf.executeCommand('moveToSubscript');
  } else {
    ok = row.mf.executeCommand(['insert', insertLatex, { insertionMode: 'replaceSelection', selectionMode: 'placeholder', format: 'latex' }]);
  }
  row.stack.push({ kind, slots: ['content'], slotIndex: 0, openPos: posBefore, latexBefore, latexAfterOpen: row.mf.value, mergeTarget, ...opts });
  checkDepth(row);
  return ok;
}

/** n/α: 空の分数を作り分子へカーソル（2スロット: num, den） */
function openNfrac(row) {
  const posBefore = row.mf.position;
  const latexBefore = row.mf.value;
  const sel = row.mf.selection;
  const hasSelection = sel && sel.ranges && sel.ranges.some(([a, b]) => a !== b);
  row.runStack.push(row.run);
  row.run = [];
  if (hasSelection) {
    // 「項を選択している状態で押した場合は、その項を分母に置いて分子へカーソル」
    row.mf.executeCommand(['insert', '\\dfrac{#?}{#@}', { format: 'latex' }]);
  } else {
    row.mf.executeCommand(['insert', '\\dfrac{#0}{#0}', { insertionMode: 'replaceSelection', selectionMode: 'placeholder', format: 'latex' }]);
  }
  row.stack.push({ kind: 'nfrac', slots: ['num', 'den'], slotIndex: 0, openPos: posBefore, latexBefore, latexAfterOpen: row.mf.value, mergeTarget: null });
  checkDepth(row);
}

/** α/n: カーソル直前の項を分子に取り、分母へカーソル（1スロット: den。分子は既に確定済み） */
function openAfrac(row) {
  const term = lastTerm(row);
  const posBefore = row.mf.position;
  const latexBefore = row.mf.value;
  row.runStack.push(row.run);
  row.run = [];
  if (term) {
    row.mf.selection = { ranges: [[term.start, term.end]] };
    row.mf.executeCommand(['insert', '\\dfrac{#@}{#?}', { format: 'latex' }]);
  } else {
    // 曖昧: 「直前の項」が無いときの挙動は仕様に明記が無い。
    // フォールバックとして n/α と同じ空分数にする（分子分母とも空プレースホルダ）。
    row.mf.executeCommand(['insert', '\\dfrac{#0}{#0}', { insertionMode: 'replaceSelection', selectionMode: 'placeholder', format: 'latex' }]);
  }
  row.stack.push({ kind: 'afrac', slots: ['den'], slotIndex: 0, openPos: term ? term.start : posBefore, latexBefore, latexAfterOpen: row.mf.value, mergeTarget: null });
  checkDepth(row);
}

/** Σ: k=1 と n の2スロット（下付き→上付き）
 * 注意: `\sum_{#0}^{#0}` を selectionMode:'placeholder' で挿入すると、実測で最初に選ばれる
 * プレースホルダが上付き側になってしまう（frac の num/den とは選択順が異なる）。
 * そのため sum だけは moveToSubscript/moveToSuperscript を明示的に呼んで順序を確定させる。 */
function openSum(row) {
  const posBefore = row.mf.position;
  const latexBefore = row.mf.value;
  row.runStack.push(row.run);
  row.run = [];
  row.mf.executeCommand(['insert', '\\sum', { insertionMode: 'insertAfter', format: 'latex' }]);
  row.mf.executeCommand('moveToSubscript');
  // subscript -> superscript の兄弟スロット送りは moveToOpposite（同じ親の反対側ブランチへ）を使う。
  // moveToSuperscript は「直前のアトムに新しい上付きを付ける」動作なので、既に下付きの中にいる状態だと
  // 下付きの中身（例: "1"）に入れ子でぶら下がってしまい兄弟にならない（実測で確認）。
  row.stack.push({ kind: 'sum', slots: ['sub', 'sup'], slotIndex: 0, openPos: posBefore, latexBefore, latexAfterOpen: row.mf.value, mergeTarget: null, advanceCommands: ['moveToOpposite'] });
  checkDepth(row);
}

/** スペース: 最も内側の未確定スロットを1段だけ閉じる（多スロットなら次スロットへ送るだけ） */
function closeOneLevel(row) {
  if (row.stack.length === 0) return; // 全部閉じきった状態でのスペースは何もしない
  const frame = row.stack[row.stack.length - 1];
  row.history.push(snapshotForHistory(row));

  if (frame.slotIndex < frame.slots.length - 1) {
    // 多スロット構造の途中送り（分子→分母 等）。構造自体はまだ閉じない。
    const advanceCmd = frame.advanceCommands?.[frame.slotIndex] ?? 'moveToNextPlaceholder';
    frame.slotIndex += 1;
    row.run = [];
    row.mf.executeCommand(advanceCmd);
    checkDepth(row);
    return;
  }

  // 最終スロット → 構造ごと1段閉じて外へ出る
  row.stack.pop();
  const finishedRun = row.run;
  row.run = row.runStack.pop() ?? [];
  row.mf.executeCommand('moveAfterParent');
  if (frame.kind === 'text') {
    row.nativeTextOpen = false;
    if (nativeTextRow === row) nativeTextRow = null;
    row.mf.executeCommand(['switchMode', 'math']);
    // 文を閉じた瞬間から標準IMEの入力先を外す。
    focusProxyAfterNativeClose(row);
    scheduleConversionCaret(row);
  }
  const closePos = row.mf.position;

  if (frame.mergeTarget) {
    // パターン3: 変数＋添字 を1つの項に結合
    frame.mergeTarget.end = closePos;
    frame.mergeTarget.kind = 'varScript';
  } else {
    pushToken(row, { kind: 'group', start: frame.openPos, end: closePos });
  }
  checkDepth(row);
}

/**
 * Backspace。スロットスタックがあるので、素の1文字削除では足りない。
 * 規則は3つだけ（打つ前に考えなくて済むよう、場合分けを増やさない）:
 *   1. いまのスロットに中身がある → 1つ消す
 *   2. いまのスロットが空で、多スロット構造の2つ目以降にいる → 前のスロットへ戻る
 *      （スペースの「次のスロットへ送る」のちょうど逆）
 *   3. いまのスロットが空で、構造の先頭にいる → 構造ごと無かったことにする
 * 3が要点。押し間違えた `n/α` や `√` を、1回のBackspaceで取り消せる。
 */
function backspace(row) {
  // 変換の読みが空で、数式ブロックそのものにも内容が無いときだけブロックを閉じる。
  // 読みがある場合はrouteShikitypeImeKeyが先にrawを一打鍵だけ戻すため、ここへは
  // 到達しない。最後の行モードblockは入力先として残し、キャンバスだけ0個を許す。
  if (isEmptyMathBlock(row) && !row?.conversion?.raw && removeEmptyRow(row)) return;
  // 保存から復元した行は操作履歴を持たない。現在位置の深さだけ合わせてから
  // MathLive本来の安全な削除へ渡すことで、分数や括弧の途中でも全体を失わない。
  reconcileStack(row);
  const frame = row.stack[row.stack.length - 1];
  const slotEmpty = row.run.length === 0;

  // 新しく開いた空構造から矢印で外へ出た直後は、現在の深さが0でもその構造だけは
  // 自前で特定できる。開いた直後のLaTeXと一致する場合に限り、1回のBackspaceで
  // その構造だけを取り消す。復元済みの分数や別行には触れない。
  const detached = row.detachedFrames[row.detachedFrames.length - 1];
  if (!frame && detached?.latexAfterOpen === row.mf.value) {
    row.detachedFrames.pop();
    row.mf.value = detached.latexBefore;
    row.mf.position = detached.openPos;
    row.run = [];
    reconcileStack(row);
    checkDepth(row);
    return;
  }

  // 保存済みLaTexからカーソル移動で入り直した構造は、MathLiveが深さを返しても
  // 分子/分母などの種類までは返さない。空の境界でdeleteBackwardを直接渡すと、
  // 分数そのものを1アトムとして消すことがある。ここでは1文字前へ戻すだけにし、
  // 利用者が中身へ戻れるようにする（既知フレームの通常規則には影響しない）。
  if (frame?.kind === 'unknown' && slotEmpty) {
    const info = (() => { try { return row.mf.getElementInfo(row.mf.position); } catch { return null; } })();
    const leaf = info ? String(info.latex ?? '') : '';
    if (leaf === '' || leaf === '\\placeholder{}') {
      row.mf.executeCommand('moveToPreviousChar');
      reconcileStack(row);
      return;
    }
  }

  if (frame && slotEmpty) {
    if (frame.slotIndex > 0) {
      // 規則2: 前のスロットへ戻る。ただし今のスロットに中身が残っている場合は
      // その中身を1つだけ消して分母に留まる（素のdeleteBackwardはスロット内で安全）。
      const info = (() => { try { return row.mf.getElementInfo(row.mf.position); } catch { return null; } })();
      const leaf = info ? String(info.latex ?? '') : '';
      if (leaf !== '' && leaf !== '\\placeholder{}') {
        row.mf.executeCommand('deleteBackward');
        reconcileStack(row);
        checkDepth(row);
        return;
      }
      frame.slotIndex -= 1;
      row.mf.executeCommand('moveToOpposite');
      checkDepth(row);
      return;
    }
    // 規則3: 構造ごと取り消す。開いた時点の LaTeX を持たせてあるので厳密に戻せる
    if (frame.latexBefore !== undefined) {
      row.stack.pop();
      row.run = row.runStack.pop() ?? [];
      row.mf.value = frame.latexBefore;
      row.mf.position = frame.openPos;
      checkDepth(row);
      return;
    }
  }

  // 規則1: 通常の1つ削除。削除でカーソルより後ろになった項は「直前の項」から外す。
  // 構造の直後に立っている場合も、素の deleteBackward は1アトムだけを正しく削除する
  // （2026-08-23 再実測。以前の「構造ごと消える」は moveToPreviousChar を併用した
  // 実装側の副作用だった）。MathLive の素の挙動に任せるのが最も安全。
  row.mf.executeCommand('deleteBackward');
  // 構造の中へ入って削除した場合、MathLive が閉じ側のコマンドを孤立させることがある
  // （実測: (xyz) の外から Backspace で閉じ側の断片が残る）。このときだけ
  // 開き側と対になる閉じ側を取り除いて整形する。
  if (row.mf.value.includes('\\left(') && !row.mf.value.includes('\\right)')) {
    if (row.mf.value.endsWith('\\right.')) {
      row.mf.value = row.mf.value.slice(0, -'\\right.'.length);
      row.mf.position = row.mf.lastOffset;
    }
  }
  const pos = row.mf.position;
  while (row.run.length > 0 && row.run[row.run.length - 1].end > pos) row.run.pop();
  reconcileStack(row);
  checkDepth(row);
}

/**
 * ←→ でのカーソル移動。
 *
 * ここは自前スタックの弱点に触る。スタックは「自分が開いた構造」を積んでいるだけなので、
 * 矢印で構造の外へ出たり、既に閉じた構造の中へ入り直したりすると実際の位置とズレる。
 * かといってMathLive側はスロットの種類を返してくれない（3F7Bで実測済み）ので、
 * 種類を復元することはできない。
 *
 * そこで「深さだけは必ず合わせ、種類は分かる範囲だけ名乗る」方針にする:
 *   - 浅くなった（構造の外へ出た） → その分スタックをpopする
 *   - 深くなった（閉じた構造の中へ入った） → 種類不明のフレームを積む（パンくずには「?」と出す）
 * これでスペースの「1段閉じる」は移動後も正しく効く（moveAfterParent は種類に依らないため）。
 */
function moveCaret(row, dir) {
  row.mf.executeCommand(dir < 0 ? 'moveToPreviousChar' : 'moveToNextChar');
  reconcileStack(row);
  scheduleConversionCaret(row);
}

function reconcileStack(row) {
  let mlDepth;
  try {
    const info = row.mf.getElementInfo(row.mf.position);
    mlDepth = info ? info.depth : undefined;
  } catch { mlDepth = undefined; }
  if (mlDepth === undefined) return;

  const popped = [];
  while (row.stack.length > mlDepth) {
    const frame = row.stack.pop();
    popped.push(frame);
    if (frame.kind !== 'unknown' && frame.latexAfterOpen !== undefined) row.detachedFrames.push(frame);
    row.run = row.runStack.pop() ?? [];
  }
  // 構造の外へ出たとき、その構造を「直前の項」として復元する。
  // これがないと (xyz) の外で Backspace を押したとき run が空のままになり、
  // 安全削除の判定（leaf を見る）は効くが、α/n などが項を掴めなくなる。
  if (popped.length) {
    const start = Math.min(...popped.map((f) => f.openPos), row.mf.position);
    row.run.push({ kind: 'group', start, end: row.mf.position });
    // textの末尾から矢印やクリックで外へ出たら、MathLiveの入力モードも
    // 数式へ戻す。これをしないと次の物理キーが文章として残る。
    if (popped.some((frame) => frame.kind === 'text')) row.mf.executeCommand(['switchMode', 'math']);
  }
  while (row.stack.length < mlDepth) {
    row.runStack.push(row.run);
    row.run = [];
    row.stack.push({ kind: 'unknown', slots: ['content'], slotIndex: 0, openPos: row.mf.position });
  }
}

/** ↑↓ で行を移動する。Pass 1 は行を縦に積むだけなので、前の行へ戻る唯一の手段。 */
function moveRow(dir) {
  const next = activeRowIndex + dir;
  if (next < 0 || next >= rows.length) return;
  claimRowFocus(rows[next]);
}

/** Shift+Space: 直前のスペース操作を1段開き直す */
function reopenOneLevel(row) {
  if (row.history.length === 0) return;
  const snap = row.history.pop();
  row.stack = snap.stack;
  row.run = snap.run;
  row.runStack = snap.runStack;
  row.mf.position = snap.position;
}

/** MathLive の depth と自前スタックの整合性チェック（ズレ検知のみ・権威にはしない） */
function checkDepth(row) {
  try {
    const info = row.mf.getElementInfo(row.mf.position);
    const mlDepth = info ? info.depth : undefined;
    if (mlDepth !== undefined && mlDepth !== row.stack.length) {
      console.warn('[neo-math][stack-mismatch]', { row: row.id, ours: row.stack.length, mathlive: mlDepth, latex: row.mf.value });
    }
  } catch (e) {
    // 取得できないケースもある（3F7B実測どおり）。権威ではないので無視してよい。
  }
}

// ---------------------------------------------------------------------------
// 構造の内部にいる時だけ、その数式行の直下に現在のスロットを最小表示する。
// root（閉じている）では何も出さず、式のための余白と認知負荷を増やさない。
// ---------------------------------------------------------------------------

const SLOT_KIND_CONTEXT_LABELS = {
  paren: '括弧内', sup: '上付き', sub: '下付き', sqrt: '根号内', abs: '絶対値内',
  unknown: '式の中', nfrac: '分子', afrac: '分母', lim: '極限の中', sum: '下付き', text: '文の中',
};

// 内部スロットを2つ以上持つものだけ、いま何番目のスロットにいるかを出す。
// 分子と分母が同じ表示だと「今どっちだっけ」が残り、パンくずの目的
// （押す回数を数えさせない）が半分しか果たせないため。
// スロットが1つしかないもの（括弧・上付き・根号等）には無意味な括弧書きを足さない。
const SLOT_NAME_LABELS = {
  num: '分子', den: '分母', sub: '下', sup: '上',
};

function slotLabel(frame) {
  const slots = frame.slots ?? [];
  if (slots.length < 2) return SLOT_KIND_CONTEXT_LABELS[frame.kind] ?? '式の中';
  const name = SLOT_NAME_LABELS[slots[frame.slotIndex]];
  return name ?? SLOT_KIND_CONTEXT_LABELS[frame.kind] ?? '式の中';
}

function renderBreadcrumb() {
  for (const candidate of rows) {
    if (candidate.slotContext) {
      candidate.slotContext.hidden = true;
      candidate.slotContext.replaceChildren();
    }
  }
  const row = activeRow();
  const stack = row ? row.stack : [];
  const el = row?.slotContext;
  if (!el || stack.length === 0) return;
  const labels = stack.map(slotLabel).filter(Boolean);
  if (!labels.length) return;
  labels.forEach((label, i) => {
    const isLast = i === labels.length - 1;
    const span = document.createElement('span');
    span.className = 'crumb' + (isLast ? ' current' : '');
    span.textContent = label;
    el.appendChild(span);
    if (i < labels.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      el.appendChild(sep);
    }
  });
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// 項として積む系のアクション（変数・数字・関数・リテラル）
// ---------------------------------------------------------------------------

function insertVariable(row, letter) {
  const posBefore = row.mf.position;
  row.mf.executeCommand(['insert', letter, { insertionMode: 'insertAfter', format: 'latex' }]);
  pushToken(row, { kind: 'var', start: posBefore, end: row.mf.position });
  checkDepth(row);
}

function insertDigit(row, digit) {
  const posBefore = row.mf.position;
  row.mf.executeCommand(['insert', digit, { insertionMode: 'insertAfter', format: 'latex' }]);
  pushToken(row, { kind: 'digits', start: posBefore, end: row.mf.position });
  checkDepth(row);
}

function insertTermLiteral(row, latex) {
  const posBefore = row.mf.position;
  row.mf.executeCommand(['insert', latex, { insertionMode: 'insertAfter', format: 'latex' }]);
  pushToken(row, { kind: 'var', start: posBefore, end: row.mf.position });
  checkDepth(row);
}

function insertFunc(row, name) {
  const posBefore = row.mf.position;
  // sin/cos/tan/log は MathLive 組み込みの関数コマンド（\sin 等）としてローマン体・自動スペーシングで入る
  row.mf.executeCommand(['insert', '\\' + name + ' ', { insertionMode: 'insertAfter', format: 'latex' }]);
  row.run.push({ kind: 'func', start: posBefore, end: row.mf.position });
  checkDepth(row);
}

function insertLiteral(row, latex) {
  row.mf.executeCommand(['insert', latex, { insertionMode: 'insertAfter', format: 'latex' }]);
  clearRun(row); // 演算子・区切り記号は項の連なりを断つ
  checkDepth(row);
}

function openText(row) {
  const posBefore = row.mf.position;
  const latexBefore = row.mf.value;
  row.runStack.push(row.run);
  row.run = [];
  row.mf.executeCommand(['insert', '\\text{#0}', { insertionMode: 'replaceSelection', selectionMode: 'placeholder', format: 'latex' }]);
  // MathLive自身もtext modeへ切り替える。\\text{}を見た目だけ挿入してmath modeの
  // ままにすると、OSの通常入力がプレースホルダ全体を置換して文章構造を失う。
  row.mf.executeCommand(['switchMode', 'text']);
  row.stack.push({ kind: 'text', slots: ['content'], slotIndex: 0, openPos: posBefore, latexBefore, latexAfterOpen: row.mf.value, mergeTarget: null });
  row.nativeTextOpen = true;
  nativeTextRow = row;
  updateConversionCaret(row);
  checkDepth(row);
  // 文だけはMathLiveの実入力面へ戻す。通常数式ではこの面にfocusを置かないため、
  // Windows IMEが数式へcompositionを始める入口を持たない。
  requestAnimationFrame(() => {
    if (activeRow() === row && row.nativeTextOpen && row.mf.isConnected) row.mf.focus();
  });
}

function insertOperator(row, symbol) {
  row.mf.executeCommand(['insert', symbol, { insertionMode: 'insertAfter', format: 'latex' }]);
  clearRun(row);
  checkDepth(row);
}

// ---------------------------------------------------------------------------
// ブロック（行）の生成・フォーカス管理
// ---------------------------------------------------------------------------

const blockEl = document.getElementById('block');
const canvasViewport = document.getElementById('canvas-viewport');
const editorSheet = document.getElementById('editor-sheet');
const CANVAS_MIN_ZOOM = 0.4;
const CANVAS_MAX_ZOOM = 2.5;
const CANVAS_COORDINATE_LIMIT = 12000;
// 空白面を押した位置はそのまま新規blockの左上にする。ただし、狭い画面や
// pan後にblock全体（×を含む）が最初から画面外に出ないよう、この余白だけは守る。
const CANVAS_NEW_BLOCK_INSET = 8;
// Alt+ドラッグ複製の初期位置ずらし幅と、同じ内容を連続貼り付けしたときに
// 完全に重ならないよう1回ごとに足していく貼り付けオフセットの単位。
const CANVAS_DUPLICATE_OFFSET = 24;
const CANVAS_PASTE_OFFSET_STEP = 32;
let layoutMode = 'rows';
let canvasCamera = { x: 72, y: 54, zoom: 1 };
let canvasPointer = null;
const canvasTouches = new Map();
let canvasPinch = null;
// 段階2: canvasの矩形選択・ブロックdrag・ブロックコピー貼り付け用の状態。
let selectedRows = new Set(); // 矩形選択で選ばれたRowStateの集合（見た目はis-selectedクラス）
// 矩形選択の直後は、選択前に編集していた行のMathLive内部sinkがdocument.activeElement
// へ残ったまま（blur()してもMathLive自身の非同期な内部復帰でblur直後に再取得される。
// 実測でMathLive側のfocus呼び出し(vendor/mathlive.min.mjs内)がblur後も遅れて発生する
// ことを確認済み。アプリ側のclaimRowFocus系の仕組みでは止められない）になりうる。
// document.activeElementのwithinRow判定だけでDelete/Backspaceの宛先を決めると、
// 「選択は見えているのに何も消えない、代わりに元の行の中身が1文字消える」という
// 実害が起きる。この矛盾を避けるため、直近の操作が矩形選択だったことを専用フラグで
// 覚えておき、キー判定はDOM focusでなくこのフラグを優先する。ユーザーが実際に
// どこかの行へ明示的に手を伸ばした（クリック・入力）時点でフラグを下ろす。
let selectionFocusOverride = false;
let canvasSelectDrag = null; // 矩形選択ドラッグ中のポインタ情報（{id, start, current}）
let selectBoxEl = null; // 矩形選択の可視化オーバーレイ要素
let blockDrag = null; // ブロック移動/複製ドラッグ中の状態（{pointerId, startWorld, entries}）
let blockClipboard = null; // ブロックコピー&ペーストの内部クリップボード（OSクリップボードは使わない）
let blockClipboardPasteCount = 0; // 同じコピー内容を連続貼り付けした回数（貼り付け位置をずらす）

function clampCanvasNumber(value, fallback, limit = CANVAS_COORDINATE_LIMIT) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(-limit, Math.min(limit, numeric)) : fallback;
}

function normalizeCanvasCamera(value) {
  return {
    x: clampCanvasNumber(value?.x, 72),
    y: clampCanvasNumber(value?.y, 54),
    zoom: Math.max(CANVAS_MIN_ZOOM, Math.min(CANVAS_MAX_ZOOM, Number(value?.zoom) || 1)),
  };
}

function makeBlockId() {
  return `block-${crypto.randomUUID()}`;
}

function isBlockId(value) {
  return typeof value === 'string' && /^block-[a-z0-9-]{8,120}$/i.test(value);
}

function normalizedBlockIds(value, count) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  return Array.from({ length: Math.max(0, Math.min(80, count)) }, (_, index) => {
    const candidate = source[index];
    const id = isBlockId(candidate) && !seen.has(candidate) ? candidate : makeBlockId();
    seen.add(id);
    return id;
  });
}

function normalizeNoteLayout(value, fallbackRows = []) {
  const blockIds = normalizedBlockIds(value?.blockIds, fallbackRows.length);
  const blocks = Array.isArray(value?.blocks) ? value.blocks.slice(0, 80)
    .filter((item) => item && typeof item.latex === 'string' && item.latex.length <= 4000)
    .map((item, index) => ({ id: isBlockId(item.id) ? item.id : blockIds[index] || makeBlockId(), latex: item.latex, x: clampCanvasNumber(item.x, 24), y: clampCanvasNumber(item.y, 96 + index * 104) })) : [];
  if (value?.mode === 'canvas') {
    const safeBlocks = blocks.length ? blocks : fallbackRows.slice(0, 80).map((latex, index) => ({ id: blockIds[index], latex: String(latex || ''), x: 24, y: 96 + index * 104 }));
    const safeIds = normalizedBlockIds(safeBlocks.map((block) => block.id), fallbackRows.length);
    safeBlocks.forEach((block, index) => { block.id = safeIds[index]; });
    return { mode: 'canvas', camera: normalizeCanvasCamera(value.camera), blocks: safeBlocks, blockIds: safeIds };
  }
  return { mode: 'rows', camera: normalizeCanvasCamera(null), blocks: [], blockIds };
}

function rowWorldPosition(row, index = rows.indexOf(row)) {
  return {
    x: clampCanvasNumber(row?.wrap?.dataset.canvasX, 24),
    y: clampCanvasNumber(row?.wrap?.dataset.canvasY, 96 + Math.max(0, index) * 104),
  };
}

function setRowWorldPosition(row, position, index = rows.indexOf(row)) {
  if (!row?.wrap) return;
  const next = {
    x: clampCanvasNumber(position?.x, 24),
    y: clampCanvasNumber(position?.y, 96 + Math.max(0, index) * 104),
  };
  row.wrap.dataset.canvasX = String(next.x);
  row.wrap.dataset.canvasY = String(next.y);
  if (layoutMode === 'canvas') {
    row.wrap.style.left = `${next.x}px`;
    row.wrap.style.top = `${next.y}px`;
  } else {
    row.wrap.style.left = '';
    row.wrap.style.top = '';
  }
}

function fitCanvasRowsToViewport() {
  if (!canvasViewport) return;
  const width = canvasViewport.getBoundingClientRect().width;
  if (layoutMode !== 'canvas' || width <= 0) {
    rows.forEach((row) => { row.wrap.style.width = ''; });
    return;
  }
  // 世界座標とcameraを変えず、現在画面に見えている右端までをblock幅にする。
  // 狭幅では初期/新規blockの×まで一緒に入れ、任意座標の既存blockはpanで到達する
  // というcanvasの性質を保つ。120pxは左の行番号+数式欄+44px削除領域の最小幅。
  rows.forEach((row, index) => {
    const position = rowWorldPosition(row, index);
    const screenLeft = canvasCamera.x + position.x * canvasCamera.zoom;
    const available = (width - 10 - screenLeft) / canvasCamera.zoom;
    const fitted = Math.max(120, Math.min(580, available));
    row.wrap.style.width = `${fitted}px`;
  });
}

function applyCanvasTransform() {
  if (!blockEl || !canvasViewport) return;
  // math-field へfocusを移すと、overflow:hidden のviewportにも内部scrollが残る
  // ことがある。canvasの表示位置はcameraだけを正とし、内部scrollは常に0へ戻す。
  // これをしないと狭幅で初期block/削除ボタンが見かけ上clipされる。
  if (layoutMode === 'canvas') {
    canvasViewport.scrollLeft = 0;
    canvasViewport.scrollTop = 0;
  }
  blockEl.style.transform = layoutMode === 'canvas'
    ? `translate(${canvasCamera.x}px, ${canvasCamera.y}px) scale(${canvasCamera.zoom})`
    : '';
  scheduleConversionCaret(activeRow());
}

function renderLayoutMode() {
  const canvas = layoutMode === 'canvas';
  editorSheet?.classList.toggle('canvas-mode', canvas);
  document.querySelectorAll('.layout-mode-choice').forEach((button) => {
    const selected = button.dataset.layoutMode === layoutMode;
    button.setAttribute('aria-pressed', String(selected));
  });
  rows.forEach((row, index) => setRowWorldPosition(row, rowWorldPosition(row, index), index));
  applyCanvasTransform();
  requestAnimationFrame(fitCanvasRowsToViewport);
}

function noteLayoutSnapshot() {
  return {
    mode: layoutMode,
    camera: { ...canvasCamera },
    // indexではなく作成時のIDを保存する。行の挿入・削除・並べ替え後も見直し結果が
    // 同じ数式ブロックを指せるように、rows本文と同じ順序で持つ。
    blockIds: rows.map((row) => row.id),
    // 行モードはrowsが唯一の本文。ここへ同じLaTeXを重ねて保存すると、大きな既存
    // ノートが容量上限を二重に消費する。配置が必要なキャンバスだけを完全保存する。
    blocks: layoutMode === 'canvas'
      ? rows.map((row, index) => ({ id: row.id, latex: String(row.mf.value || ''), ...rowWorldPosition(row, index) }))
      : [],
  };
}

function setLayoutMode(nextMode, persist = true) {
  if (nextMode !== 'rows' && nextMode !== 'canvas') return false;
  if (nextMode === 'canvas') rows.forEach((row, index) => setRowWorldPosition(row, rowWorldPosition(row, index), index));
  layoutMode = nextMode;
  renderLayoutMode();
  if (persist) scheduleNoteSave();
  return true;
}

function canvasPoint(event) {
  const rect = canvasViewport?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function canvasWorldPoint(point) {
  return {
    x: clampCanvasNumber((point.x - canvasCamera.x) / canvasCamera.zoom, 112),
    y: clampCanvasNumber((point.y - canvasCamera.y) / canvasCamera.zoom, 96),
  };
}

function clampNewCanvasRowToViewport(row, requestedPosition) {
  if (!canvasViewport || !row?.wrap || layoutMode !== 'canvas') return requestedPosition;

  // 先に押下位置へ置いて幅を決める。既存blockには触れず、新規blockだけを
  // viewport端で止めるので、保存済みの座標・camera・pan/zoomの意味は変わらない。
  setRowWorldPosition(row, requestedPosition);
  fitCanvasRowsToViewport();

  const viewport = canvasViewport.getBoundingClientRect();
  const block = row.wrap.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0 || block.width <= 0 || block.height <= 0) return requestedPosition;

  const minLeft = CANVAS_NEW_BLOCK_INSET;
  const minTop = CANVAS_NEW_BLOCK_INSET;
  const maxLeft = Math.max(minLeft, viewport.width - block.width - CANVAS_NEW_BLOCK_INSET);
  const maxTop = Math.max(minTop, viewport.height - block.height - CANVAS_NEW_BLOCK_INSET);
  const screenLeft = Math.max(minLeft, Math.min(maxLeft, block.left - viewport.left));
  const screenTop = Math.max(minTop, Math.min(maxTop, block.top - viewport.top));
  const clamped = {
    x: clampCanvasNumber((screenLeft - canvasCamera.x) / canvasCamera.zoom, requestedPosition.x),
    y: clampCanvasNumber((screenTop - canvasCamera.y) / canvasCamera.zoom, requestedPosition.y),
  };
  setRowWorldPosition(row, clamped);
  // xを端へ寄せると利用可能幅が増減するため、最終位置に対してもう一度だけ幅を合わせる。
  fitCanvasRowsToViewport();
  return clamped;
}

function scheduleCanvasSave() {
  // 既存ノートなら、式を増減しないカメラ移動だけでも保存対象にする。
  if (notesStore.notes.some((note) => note.id === notesStore.activeId)) scheduleNoteSave();
}

function createCanvasRowAt(worldPoint) {
  const row = createRow(false, '', worldPoint);
  clampNewCanvasRowToViewport(row, worldPoint);
  // pointerup後やMathLive mount後の既定focusが空白面・旧blockへ戻しても、
  // 入力先は新ブロックのままにする。
  claimRowFocus(row);
  fitCanvasRowsToViewport();
  scheduleNoteSave();
  commitHistoryBoundary();
  return row;
}

// ---------------------------------------------------------------------------
// canvas: 矩形選択・まとめて移動/削除
// ---------------------------------------------------------------------------

function setSelectedRows(list) {
  // 選択が入れ替わるたび（新しい矩形選択・貼り付け直後の自動選択・解除）に一旦下ろす。
  // 「直近の操作が矩形選択だった」という意味を持たせたいのはfinishPointer側の1箇所
  // だけなので、そちらで選択確定の直後に改めて立て直す。
  selectionFocusOverride = false;
  const next = new Set(list);
  rows.forEach((row) => row.wrap?.classList.toggle('is-selected', next.has(row)));
  selectedRows = next;
}

function clearSelection() {
  if (selectedRows.size) setSelectedRows([]);
}

function ensureSelectBoxEl() {
  if (selectBoxEl || !canvasViewport) return;
  selectBoxEl = document.createElement('div');
  selectBoxEl.className = 'canvas-select-box';
  canvasViewport.appendChild(selectBoxEl);
}

function selectBoxScreenRect() {
  if (!canvasSelectDrag) return { left: 0, top: 0, width: 0, height: 0 };
  const { start, current } = canvasSelectDrag;
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

function updateSelectBoxEl() {
  if (!selectBoxEl) return;
  const rect = selectBoxScreenRect();
  selectBoxEl.style.left = `${rect.left}px`;
  selectBoxEl.style.top = `${rect.top}px`;
  selectBoxEl.style.width = `${rect.width}px`;
  selectBoxEl.style.height = `${rect.height}px`;
}

function removeSelectBoxEl() {
  selectBoxEl?.remove();
  selectBoxEl = null;
}

// 矩形（viewport相対のscreen座標）と各行の実際の描画矩形（getBoundingClientRect）を
// 直接比較する。world座標へ変換して比較しないのは、zoomの値によらず「今画面に見えて
// いる重なり」がそのまま選択結果になるようにするため。
function applyRectSelection(rect) {
  if (!canvasViewport) return;
  const viewportRect = canvasViewport.getBoundingClientRect();
  const hit = rows.filter((row) => {
    const box = row.wrap.getBoundingClientRect();
    const left = box.left - viewportRect.left;
    const top = box.top - viewportRect.top;
    const right = box.right - viewportRect.left;
    const bottom = box.bottom - viewportRect.top;
    return left < rect.left + rect.width && right > rect.left && top < rect.top + rect.height && bottom > rect.top;
  });
  setSelectedRows(hit);
}

function deleteSelectedRows() {
  if (!selectedRows.size) return;
  const targets = [...selectedRows];
  targets.forEach((row) => removeEmptyRow(row, { requireEmpty: false, skipHistory: true }));
  setSelectedRows([]);
  scheduleNoteSave();
  commitHistoryBoundary();
}

// ---------------------------------------------------------------------------
// canvas: ブロックのdrag移動・Alt+drag複製
// ---------------------------------------------------------------------------

function duplicateRowNear(row) {
  const pos = rowWorldPosition(row);
  const copy = createRow(false, String(row.mf.value || ''), { x: pos.x + CANVAS_DUPLICATE_OFFSET, y: pos.y + CANVAS_DUPLICATE_OFFSET });
  fitCanvasRowsToViewport();
  return copy;
}

function onBlockDragMove(event) {
  if (!blockDrag || event.pointerId !== blockDrag.pointerId) return;
  const world = canvasWorldPoint(canvasPoint(event));
  const dx = world.x - blockDrag.startWorld.x;
  const dy = world.y - blockDrag.startWorld.y;
  blockDrag.entries.forEach(({ row, start }) => setRowWorldPosition(row, { x: start.x + dx, y: start.y + dy }));
  event.preventDefault();
}

function endBlockDrag(event) {
  if (!blockDrag || (event && event.pointerId !== blockDrag.pointerId)) return;
  document.removeEventListener('pointermove', onBlockDragMove);
  document.removeEventListener('pointerup', endBlockDrag);
  document.removeEventListener('pointercancel', endBlockDrag);
  canvasViewport?.classList.remove('is-block-dragging');
  blockDrag?.entries.forEach(({ row }) => row.wrap?.classList.remove('is-dragging'));
  blockDrag = null;
  fitCanvasRowsToViewport();
  scheduleNoteSave();
  // ブロック移動の確定はここで1つの取り消し単位にする（段階1の設計どおり、
  // pointerupで一度だけcommitHistoryBoundary()を呼ぶ）。
  commitHistoryBoundary();
}

// wrapのpointerdownから呼ぶ。event.altKeyなら「掴んだ瞬間に複製し、複製の方を
// 動かす」（元のblockはその場に残る＝Alt+dragで複製、という一般的な操作感に合わせた）。
// 選択中のblockを掴んだ場合（複製時を除く）は選択全体をまとめて動かす。
function startBlockDrag(row, event) {
  if (blockDrag) return;
  // 選択に入っていないblockを個別に掴んだら、以前の矩形選択の「直後」扱いは終える。
  // 選択中のblockそのものを掴んだ場合（複製・グループ移動）は、掴んだ後も見た目の
  // 選択がそのまま残るため、そのDelete/Backspace対象という扱いを維持してよい。
  if (!selectedRows.has(row)) selectionFocusOverride = false;
  const isDuplicate = event.altKey;
  const targetRow = isDuplicate ? duplicateRowNear(row) : row;
  const dragRows = (!isDuplicate && selectedRows.has(row) && selectedRows.size > 1) ? [...selectedRows] : [targetRow];
  activeRowIndex = rows.indexOf(targetRow);
  claimRowFocus(targetRow);
  const startWorld = canvasWorldPoint(canvasPoint(event));
  blockDrag = {
    pointerId: event.pointerId,
    startWorld,
    entries: dragRows.map((r) => ({ row: r, start: rowWorldPosition(r) })),
  };
  canvasViewport?.classList.add('is-block-dragging');
  blockDrag.entries.forEach(({ row: r }) => r.wrap?.classList.add('is-dragging'));
  document.addEventListener('pointermove', onBlockDragMove);
  document.addEventListener('pointerup', endBlockDrag);
  document.addEventListener('pointercancel', endBlockDrag);
}

// ---------------------------------------------------------------------------
// ブロックのコピー・貼り付け（内部クリップボード）
// ---------------------------------------------------------------------------

// コピー対象は「canvasで複数選択中ならその全部」「そうでなければ現在アクティブな
// 1ブロック」。数式編集面では文字単位の範囲選択という既存機能が無い（後述キー
// ハンドラのコメント参照）ため、ここでの単位は常にブロック全体でよいと判断した。
function copyBlocksToClipboard() {
  const source = layoutMode === 'canvas' && selectedRows.size > 0 ? [...selectedRows] : (activeRow() ? [activeRow()] : []);
  if (!source.length) return false;
  blockClipboard = source.map((row) => {
    const pos = rowWorldPosition(row);
    return { latex: String(row.mf.value || ''), x: pos.x, y: pos.y };
  });
  blockClipboardPasteCount = 0;
  return true;
}

function pasteBlockClipboard() {
  if (!blockClipboard || !blockClipboard.length) return;
  let createdRows;
  if (layoutMode === 'canvas') {
    // 元の位置にそのまま重ねると見えなくなるため、右下へオフセットして貼り付ける。
    // 連続してCtrl+Vしても同じ場所へ積み重ならないよう、貼り付けるたびにオフセットを足す。
    blockClipboardPasteCount += 1;
    const offset = CANVAS_PASTE_OFFSET_STEP * blockClipboardPasteCount;
    createdRows = blockClipboard.map((entry) => createRow(false, entry.latex, { x: entry.x + offset, y: entry.y + offset }));
    fitCanvasRowsToViewport();
    setSelectedRows(createdRows);
  } else {
    // 行モードでは現在行の直下へ、コピー順のまま連続挿入する。
    const cur = activeRow();
    let insertIndex = cur ? rows.indexOf(cur) + 1 : rows.length;
    createdRows = blockClipboard.map((entry) => {
      const created = createRow(false, entry.latex, null, insertIndex);
      insertIndex += 1;
      return created;
    });
  }
  const last = createdRows[createdRows.length - 1];
  if (last) { activeRowIndex = rows.indexOf(last); claimRowFocus(last); }
  scheduleNoteSave();
  commitHistoryBoundary();
}

function updateCanvasPinch() {
  if (!canvasPinch || canvasTouches.size < 2) return;
  const [first, second] = [...canvasTouches.values()];
  const distance = Math.hypot(second.x - first.x, second.y - first.y) || canvasPinch.distance;
  const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  const zoom = Math.max(CANVAS_MIN_ZOOM, Math.min(CANVAS_MAX_ZOOM, canvasPinch.zoom * (distance / canvasPinch.distance)));
  const worldX = (canvasPinch.center.x - canvasPinch.camera.x) / canvasPinch.zoom;
  const worldY = (canvasPinch.center.y - canvasPinch.camera.y) / canvasPinch.zoom;
  canvasCamera = { x: center.x - worldX * zoom, y: center.y - worldY * zoom, zoom };
  applyCanvasTransform();
  scheduleCanvasSave();
}

function startCanvasPinch() {
  if (canvasTouches.size < 2) return;
  const [first, second] = [...canvasTouches.values()];
  canvasPinch = {
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    camera: { ...canvasCamera }, zoom: canvasCamera.zoom,
  };
  if (canvasPointer) canvasPointer.moved = true;
}

function installCanvasControls() {
  if (!canvasViewport) return;
  const capturePointer = (pointerId) => { try { canvasViewport.setPointerCapture?.(pointerId); } catch { /* synthetic/test pointerでも操作を止めない */ } };
  canvasViewport.addEventListener('pointerdown', (event) => {
    if (layoutMode !== 'canvas' || (event.target instanceof Element && event.target.closest('.row'))) return;
    const point = canvasPoint(event);
    // 空白のShift+左drag＝矩形選択。素のドラッグは既存どおりpan（拓男が明示要望した
    // 「左クリックドラッグで移動」を奪わないため、選択は別の組み合わせに割り当てる）。
    if (event.button === 0 && event.shiftKey && event.pointerType !== 'touch') {
      // 見た目だけでも手を離す（MathLiveが内部で再focusを差し戻すことがあるため、
      // これ単体では宛先の判定に使えない。判定はselectionFocusOverrideで行う）。
      if (isWithinRow(document.activeElement)) {
        rowFocusClaim += 1;
        protectedFocusRow = null;
        document.activeElement.blur();
      }
      canvasSelectDrag = { id: event.pointerId, start: point, current: point };
      capturePointer(event.pointerId);
      ensureSelectBoxEl();
      updateSelectBoxEl();
      event.preventDefault();
      return;
    }
    if (event.pointerType === 'touch') {
      canvasTouches.set(event.pointerId, point);
      capturePointer(event.pointerId);
      if (canvasTouches.size === 2) startCanvasPinch();
      else canvasPointer = { id: event.pointerId, type: 'touch', start: point, camera: { ...canvasCamera }, moved: false };
      event.preventDefault();
      return;
    }
    if (event.button === 0) {
      canvasPointer = { id: event.pointerId, type: 'mouse', start: point, camera: { ...canvasCamera }, moved: false };
      capturePointer(event.pointerId);
      event.preventDefault();
    }
  });
  canvasViewport.addEventListener('pointermove', (event) => {
    if (layoutMode !== 'canvas') return;
    const point = canvasPoint(event);
    if (canvasSelectDrag && canvasSelectDrag.id === event.pointerId) {
      canvasSelectDrag.current = point;
      updateSelectBoxEl();
      event.preventDefault();
      return;
    }
    if (event.pointerType === 'touch' && canvasTouches.has(event.pointerId)) {
      canvasTouches.set(event.pointerId, point);
      if (canvasTouches.size >= 2) { updateCanvasPinch(); event.preventDefault(); return; }
    }
    if (!canvasPointer || canvasPointer.id !== event.pointerId) return;
    const dx = point.x - canvasPointer.start.x; const dy = point.y - canvasPointer.start.y;
    if (Math.hypot(dx, dy) > 5) canvasPointer.moved = true;
    // 閾値未満は空白click/tap候補のままにし、閾値を超えた左drag/一本指dragだけを
    // パンへ切り替える。これによりdrag終了が新規block作成へ化けない。
    if (!canvasPointer.moved) return;
    canvasCamera = { ...canvasPointer.camera, x: canvasPointer.camera.x + dx, y: canvasPointer.camera.y + dy };
    canvasViewport.classList.add('is-panning');
    applyCanvasTransform();
    scheduleCanvasSave();
    event.preventDefault();
  });
  const finishPointer = (event) => {
    if (layoutMode !== 'canvas') return;
    if (canvasSelectDrag && canvasSelectDrag.id === event.pointerId) {
      const rect = selectBoxScreenRect();
      if (rect.width > 3 || rect.height > 3) applyRectSelection(rect); else clearSelection();
      // 矩形選択が実際にblockを拾った直後だけ、Delete/Backspaceの宛先判定を
      // このフラグに委ねる（選択が消える操作＝clearSelection/次の選択のたびに
      // setSelectedRowsが呼ばれるので、そちらで毎回リセットする）。
      selectionFocusOverride = selectedRows.size > 0;
      removeSelectBoxEl();
      canvasSelectDrag = null;
      return;
    }
    const wasPointer = canvasPointer?.id === event.pointerId ? canvasPointer : null;
    if (event.pointerType === 'touch') {
      canvasTouches.delete(event.pointerId);
      canvasPinch = null;
      if (canvasTouches.size === 1) {
        const [id, point] = [...canvasTouches.entries()][0];
        canvasPointer = { id, type: 'touch', start: point, camera: { ...canvasCamera }, moved: true };
      }
    }
    // 左clickと、ピンチに参加していない単独touchの短いtapだけを生成にする。
    // 右クリックは通常のcontextmenuへ任せ、drag/pinch/cancelでの生成は絶対に行わない。
    if (event.type === 'pointerup' && (wasPointer?.type === 'mouse' || wasPointer?.type === 'touch') && !wasPointer.moved && (wasPointer.type === 'touch' || event.button === 0) && canvasTouches.size === 0) {
      createCanvasRowAt(canvasWorldPoint(canvasPoint(event)));
    }
    canvasViewport.classList.remove('is-panning');
    if (wasPointer) canvasPointer = null;
  };
  canvasViewport.addEventListener('pointerup', finishPointer);
  canvasViewport.addEventListener('pointercancel', finishPointer);
  canvasViewport.addEventListener('wheel', (event) => {
    if (layoutMode !== 'canvas') return;
    const point = canvasPoint(event);
    const world = canvasWorldPoint(point);
    const zoom = Math.max(CANVAS_MIN_ZOOM, Math.min(CANVAS_MAX_ZOOM, canvasCamera.zoom * Math.exp(-event.deltaY * 0.0012)));
    if (zoom !== canvasCamera.zoom) {
      canvasCamera = { x: point.x - world.x * zoom, y: point.y - world.y * zoom, zoom };
      applyCanvasTransform();
      scheduleCanvasSave();
    }
    event.preventDefault();
  }, { passive: false });
}

window.addEventListener('resize', () => {
  if (layoutMode === 'canvas') requestAnimationFrame(() => { fitCanvasRowsToViewport(); scheduleConversionCaret(activeRow()); });
});

// ---------------------------------------------------------------------------
// 読み変換 — 数式欄そのものを専用IMEの入力先にする。
// 未確定の読みは数式へ入れず、行内のプレビューと直下の候補だけで示す。
// ---------------------------------------------------------------------------

let conversionOpen = false;
let conversionPrioritySearch = '';

// SHIKITYPE変換方式では、変換・英字・ギリシャのどの層も同じ専用IMEを通す。
// 層ごとの差は候補の順位だけで、OS IMEやMathLiveへ生の文字を渡す経路は作らない。
function isShikitypeTransformLayer() {
  return inputSystem === 'conversion';
}

// `\\text{}` は数式ではなく文章を置くための明示領域。ここだけは普段の文章と
// 同じようにOS IMEへ渡す。自前stackだけだと、保存済みの式へカーソルを戻した
// 場合に判定を失うため、現在キャレットが指すMathLive要素のLaTexで確認する。
function isNativeTextEntry(row) {
  if (!row?.mf) return false;
  // 空の\text{}直後はMathLiveのgetElementInfo()が親式を返すことがある。
  // 自前stackはこのアプリで開いた構造の権威なので、まず文フレームを優先する。
  // stackを読むだけで変更しない。capture/bubbleの両方から呼ばれても判定が揺れない。
  if (row.nativeTextOpen || row.stack[row.stack.length - 1]?.kind === 'text' || row.mf.mode === 'text') return true;
  try {
    const latex = String(row.mf.getElementInfo(row.mf.position)?.latex ?? '');
    return /^\\text\{/.test(latex);
  } catch {
    return row.stack[row.stack.length - 1]?.kind === 'text';
  }
}

const isNativeTextContext = isNativeTextEntry;

function candidateScopeForLayer(layer) {
  return layer === 'symbol' || layer === 'conversion' ? 'general' : layer;
}

function candidateIsInScope(candidate, scope) {
  // CSVで追加した候補は、分類列を増やさず従来どおり一般の数学候補として扱う。
  return (candidate.categories ?? ['general']).includes(scope);
}

const CONVERSION_CANDIDATE_DISPLAY_LIMIT = 8;

function candidatesForActiveInputLayer(state) {
  const scope = candidateScopeForLayer(activeInputLayer());
  const dictionary = activeConversionCandidates().filter((candidate) => candidateIsInScope(candidate, scope));
  // 表示はASCII rawのまま、検索だけはローマ字→かな変換後の読みとraw aliasの両方を使う。
  // これで`integral`と`せきぶん`のどちらも同じ∫へ届き、途中語もaliasの語頭だけで絞れる。
  const queries = [...new Set([state.raw, state.searchReading, state.reading].filter(Boolean))];
  const byId = new Map();
  for (const query of queries) {
    for (const candidate of rankConversionCandidates(query, conversionLearning, conversionManualPriority, Date.now(), dictionary.length, dictionary)) {
      const previous = byId.get(candidate.id);
      if (!previous || candidate.score > previous.score) byId.set(candidate.id, candidate);
    }
  }
  const ordered = [...byId.values()]
    .sort((a, b) => (b.manualPriority ?? 0) - (a.manualPriority ?? 0)
      || (b.score ?? 0) - (a.score ?? 0)
      || a.label.localeCompare(b.label, 'ja'));
  // 変換トレイは記号だけを見せるため、同じ層・同じqueryで同一glyphを複数並べない。
  // 先に並べたもの（手動順位/一致/学習が強い候補）を残す。
  const seenGlyphs = new Set();
  return ordered.filter((candidate) => {
    const glyph = candidate.label;
    if (seenGlyphs.has(glyph)) return false;
    seenGlyphs.add(glyph); return true;
  }).slice(0, CONVERSION_CANDIDATE_DISPLAY_LIMIT);
}

function updateConversionReading(state, rawValue = state.raw) {
  state.raw = String(rawValue ?? '');
  const converted = convertShikitypeReading(state.raw);
  state.reading = converted.reading;
  state.searchReading = converted.searchReading;
  state.pending = converted.pending;
  // 検索はローマ字をかなへ正規化して辞書へ渡すが、利用者に見せる未確定文字は
  // 常に物理キーどおりの英字。OSのかな変換が混ざったように見せない。
  state.preview.textContent = state.raw;
  state.preview.hidden = !state.raw;
  return converted;
}

function clearConversionReading(state) {
  state.preview.textContent = '';
  state.preview.hidden = true;
  state.raw = '';
  state.reading = '';
  state.searchReading = '';
  state.pending = '';
  state.candidates = [];
  state.navigation = false;
  state.selectedIndex = 0;
}

function renderConversionCandidates(row) {
  const state = row.conversion;
  if (!state) return;
  const query = state.searchReading ?? state.reading ?? '';
  state.candidates = candidatesForActiveInputLayer(state);
  state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, Math.max(0, state.candidates.length - 1)));
  state.list.innerHTML = '';
  state.list.setAttribute('aria-activedescendant', state.navigation && state.candidates.length
    ? `conversion-option-${row.id}-${state.selectedIndex}` : '');
  // rawが空のときは候補トレイ自体を出さない。一方で英字一打は読みの変換結果が空でも
  // literal候補を持つので、候補が存在する限り表示・確定できるようにする。
  state.shell.hidden = inputSystem !== 'conversion' || (!state.raw && !state.pending && !query.trim());
  if (!query.trim() && state.pending && !state.candidates.length) {
    state.status.textContent = `「${state.pending}」を読みとして待機中`; 
    return;
  }
  if (!query.trim() && !state.candidates.length) {
    state.status.textContent = '読みや意味を入力。例: しぐま、総和、せきぶん';
    return;
  }
  if (!state.candidates.length) {
    state.status.textContent = '一致する記号がありません';
    return;
  }
  state.status.textContent = state.composing
    ? 'IMEの変換中です。候補は表示のみで、確定後に選べます'
    : state.navigation
    ? `${state.selectedIndex + 1} / ${state.candidates.length} を選択中。Enterで挿入`
    : `${state.candidates.length}件。Tabで候補を選択`;
  state.candidates.forEach((candidate, index) => {
    const button = document.createElement('button');
    const selected = state.navigation && index === state.selectedIndex;
    button.type = 'button';
    button.id = `conversion-option-${row.id}-${index}`;
    button.className = 'conversion-candidate' + (selected ? ' selected' : '');
    button.style.setProperty('--conversion-index', String(index));
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(selected));
    button.disabled = state.composing;
    button.setAttribute('aria-disabled', String(state.composing));
    button.dataset.candidateId = candidate.id;
    const symbol = document.createElement('b');
    symbol.textContent = candidate.label;
    // 視覚上は記号だけ。読みや説明は支援技術用の名前へ退避する。
    button.setAttribute('aria-label', `${candidate.label}を式へ挿入`);
    button.append(symbol);
    // ポインタ確定で数式欄のキャレットを失わないよう、clickで確定する。
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      if (!state.composing) commitConversionCandidate(row, candidate.id);
    });
    state.list.appendChild(button);
  });
  scheduleConversionCaret(row);
}

function closeConversion(row = activeRow(), { clear = true, focus = true } = {}) {
  if (!row?.conversion) return;
  const state = row.conversion;
  if (clear) clearConversionReading(state);
  state.shell.hidden = inputSystem !== 'conversion';
  conversionOpen = !state.shell.hidden;
  renderConversionCandidates(row);
  renderKeyGuide();
  if (focus) focusActiveRow();
}

function openConversion(row = activeRow(), focus = true) {
  if (!row?.conversion || !isShikitypeTransformLayer()) return;
  for (const candidateRow of rows) {
    if (candidateRow !== row && candidateRow.conversion) candidateRow.conversion.shell.hidden = true;
  }
  activeRowIndex = rows.indexOf(row);
  conversionOpen = true;
  row.conversion.shell.hidden = false;
  renderConversionCandidates(row);
  renderKeyGuide();
  if (focus) requestAnimationFrame(() => {
    // 開いた直後に別の行や文キーを選んだ場合、古いrAFがその選択を奪わない。
    if (activeRow() === row && row.mf.isConnected && !isNativeTextEntry(row)) focusRowInput(row);
  });
}

function insertConversionLatex(row, latex) {
  row.mf.executeCommand(['insert', latex, { insertionMode: 'insertAfter', format: 'latex' }]);
  // 変換候補は演算子・文字・構造を横断するため、既存の項ランを引き継がない。
  // RowStateそのものと開いているスロットは残るので、直後のBackspace/Spaceは既存経路で扱える。
  clearRun(row);
  checkDepth(row);
  scheduleNoteSave();
}

function commitConversionCandidate(row, candidateId) {
  const candidate = row?.conversion?.candidates?.find((item) => item.id === candidateId)
    ?? getConversionCandidate(candidateId, activeConversionCandidates());
  if (!row || !candidate || row.conversion?.composing) return false;
  const query = row.conversion?.searchReading ?? row.conversion?.reading ?? '';
  conversionLearning = recordCandidateSelection(conversionLearning, query, candidateId, Date.now(), activeConversionCandidates());
  saveConversionPreferences();
  // 再変換（2.）用に確定直前の状態を覚えておく。次のBackspaceが「何も挟まず
  // 直後」であることは、mf.value/positionが確定直後のままかで判定する
  // （detachedFramesと同じ、値の一致で確認する既存パターン）。
  const latexBefore = row.mf.value;
  const positionBefore = row.mf.position;
  const rawBefore = row.conversion?.raw ?? ''; // 見せる文字は常に物理キーどおりの英字（raw）
  insertConversionLatex(row, candidate.latex);
  row.lastConfirm = {
    latexBefore, positionBefore, raw: rawBefore,
    latexAfter: row.mf.value, positionAfter: row.mf.position,
  };
  tickKeystroke();
  renderBreadcrumb();
  // 一時遷移で変換層へ来ていた場合は、候補の確定を「1入力」として戻す。
  consumeTemporaryLayer();
  closeConversion(row, { clear: true, focus: true });
  // 候補確定は独立した取り消し単位にする（直前の読み入力や直後の打鍵と混ざらない）。
  commitHistoryBoundary();
  return true;
}

// ---------------------------------------------------------------------------
// 再変換（2.）— 確定直後に限り、Backspaceで読みへ戻す
// ---------------------------------------------------------------------------
// 「直後」の範囲: mf.value/positionが確定直後のスナップショット（latexAfter/
// positionAfter）と完全一致している間だけ有効にする。カーソル移動や他の文字入力を
// 挟むとどちらかが変わるため、自然に対象外になる（1.のUndoと違って専用の無効化
// フックを増やさず、既存コードのdetachedFramesと同じ「値の一致」で境界を判定する）。
function tryReconvertLastConfirm(row) {
  const lc = row?.lastConfirm;
  if (!lc || row.mf.value !== lc.latexAfter || row.mf.position !== lc.positionAfter) return false;
  row.lastConfirm = null;
  row.mf.value = lc.latexBefore;
  row.mf.position = lc.positionBefore;
  reconcileStack(row);
  checkDepth(row);
  openConversion(row, true);
  updateConversionReading(row.conversion, lc.raw);
  row.conversion.navigation = false;
  row.conversion.selectedIndex = 0;
  renderConversionCandidates(row);
  scheduleNoteSave();
  return true;
}

function moveConversionSelection(row, delta) {
  const state = row?.conversion;
  if (!state?.navigation || !state.candidates.length) return false;
  state.selectedIndex = (state.selectedIndex + delta + state.candidates.length) % state.candidates.length;
  renderConversionCandidates(row);
  return true;
}

function handleConversionKey(row, event) {
  const state = row?.conversion;
  if (!state || state.composing || event.isComposing || event.keyCode === 229) return false;
  if (event.code === 'Tab') {
    // 候補が無い空の変換層でまでTabを奪うと、英字／ギリシャ層への既存遷移を
    // 失う。候補が出ている間だけ候補選択をトグルし、それ以外は層切替へ渡す。
    if (!state.candidates.length && !state.navigation) return false;
    state.navigation = !state.navigation;
    if (state.navigation && state.candidates.length) state.selectedIndex = 0;
    renderConversionCandidates(row);
    return true;
  }
  if (state.navigation && ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.code)) {
    moveConversionSelection(row, event.code === 'ArrowLeft' || event.code === 'ArrowUp' ? -1 : 1);
    return true;
  }
  if (event.code === 'Enter' && state.raw) {
    // Tabは候補を見比べる入口として残すが、第一候補を採るだけなら
    // 「P → Enter」の二打で終えられる。候補が無い途中読みは式にも改行にも
    // 流さず、Esc/Backspaceでそのまま編集を続けられる。
    const candidate = state.candidates[state.navigation ? state.selectedIndex : 0];
    if (candidate) commitConversionCandidate(row, candidate.id);
    return true;
  }
  if (event.code === 'Escape') {
    closeConversion(row, { clear: true, focus: true });
    return true;
  }
  return false;
}

function appendConversionText(row, text) {
  const state = row?.conversion;
  if (!state || !text) return false;
  updateConversionReading(state, state.raw + text);
  state.navigation = false;
  state.selectedIndex = 0;
  renderConversionCandidates(row);
  return true;
}

function deleteConversionText(row) {
  const state = row?.conversion;
  if (!state) return false;
  updateConversionReading(state, Array.from(state.raw).slice(0, -1).join(''));
  state.navigation = false;
  state.selectedIndex = 0;
  renderConversionCandidates(row);
  return true;
}

function createConversionPanel(row, wrap) {
  // 入力欄・見出し・囲いは作らない。読みのプレビューは数式の続きとして表示し、
  // 候補だけをアクティブな数式行の直下へ置く。
  const preview = document.createElement('span');
  preview.className = 'conversion-reading';
  preview.hidden = true;
  preview.setAttribute('aria-live', 'polite');
  preview.setAttribute('aria-label', '変換中の読み');
  wrap.appendChild(preview);
  const slotContext = document.createElement('div');
  slotContext.className = 'slot-context';
  slotContext.hidden = true;
  slotContext.setAttribute('aria-live', 'polite');
  slotContext.setAttribute('aria-label', '数式内の現在地');
  wrap.appendChild(slotContext);
  row.slotContext = slotContext;
  const shell = document.createElement('div');
  shell.className = 'conversion-candidate-tray';
  shell.hidden = true;
  shell.setAttribute('aria-label', '変換候補');
  const list = document.createElement('div');
  list.id = `conversion-list-${row.id}`;
  list.className = 'conversion-candidates';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '変換候補');
  const status = document.createElement('p');
  status.className = 'conversion-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  shell.append(list, status);
  wrap.appendChild(shell);
  const state = {
    shell, preview, list, status, candidates: [], selectedIndex: 0, navigation: false,
    composing: false, raw: '', reading: '', searchReading: '', pending: '',
    compositionBaseRaw: '', compositionText: '',
  };
  row.conversion = state;
}

// ---------------------------------------------------------------------------
// ノート保存（この端末のブラウザ内だけで保持する。設定値はノートへ混ぜない）
// ---------------------------------------------------------------------------

const NOTE_STORAGE_KEY = 'neo-math.notes.v1';
const NOTE_STORE_VERSION = 1;
const NOTE_SAVE_DELAY_MS = 420;
const NOTE_TITLE_MAX = 80;
// 誤削除の猶予期間（段階3要件：「間違って消したものが戻らない設計にはしない」）。
// ノート削除は即時の物理削除にせず、deletedAtを立てるだけのソフトデリートにして
// 「過去のノート」一覧から隠し、ゴミ箱から復元できるようにする。この期間を過ぎた
// ものだけ、次回のstore読込時に物理削除する（無限に溜め続けない）。
const NOTE_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let notesStore = { version: NOTE_STORE_VERSION, activeId: null, notes: [] };
let noteSaveTimer = null;
let restoringNote = false;
let notesFilterQuery = '';
let notesTrashOpen = false;
let cloudAccount = { userId: null, state: 'local', epoch: 0 };
const cloudQueues = new Map();
let cloudGeneration = 0;
let accountOperation = 0;
let accountAbortController = null;
let accountSubmitting = false;
let googleAuth = { clientId: null, csrfToken: null, loading: null, intent: 'login' };
let conversionProfileRevision = 0;
let conversionProfileDirty = false;
let conversionProfileConflict = false;
let conversionProfileMutationGeneration = 0;
let conversionProfileSaveTimer = null;
const CONVERSION_ANONYMOUS_CLAIM_KEY = 'neo-math.conversion-profile-anonymous-claim.v1';

function conversionProfileStorageKey(baseKey, userId = cloudAccount.userId) {
  return userId ? `${baseKey}.user.${userId}` : baseKey;
}

function readConversionLocalProfile(userId = cloudAccount.userId) {
  let dictionary = emptyConversionDictionaryState();
  let learning = null;
  let manual = null;
  try { dictionary = sanitizeConversionDictionaryState(JSON.parse(localStorage.getItem(conversionProfileStorageKey(CONVERSION_DICTIONARY_KEY, userId)) || 'null')); }
  catch { /* 保存値が壊れても既定辞書を優先する */ }
  const candidates = effectiveConversionCandidates(dictionary);
  try { learning = JSON.parse(localStorage.getItem(conversionProfileStorageKey(CONVERSION_LEARNING_KEY, userId)) || 'null'); }
  catch { /* 学習値が壊れても続ける */ }
  try { manual = JSON.parse(localStorage.getItem(conversionProfileStorageKey(CONVERSION_MANUAL_PRIORITY_KEY, userId)) || 'null'); }
  catch { /* 手動順位が壊れても続ける */ }
  conversionDictionary = dictionary;
  conversionLearning = sanitizeLearningState(learning, candidates);
  conversionManualPriority = sanitizeManualPriorityState(manual, candidates);
  let meta = null;
  try { meta = JSON.parse(localStorage.getItem(conversionProfileStorageKey(CONVERSION_PROFILE_META_KEY, userId)) || 'null'); }
  catch { /* 旧版値へ安全に移行する */ }
  const legacyRevision = Number(localStorage.getItem(conversionProfileStorageKey(CONVERSION_PROFILE_REVISION_KEY, userId)) || '0');
  const revision = Number(meta?.revision ?? legacyRevision);
  conversionProfileRevision = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  // meta未導入の端末には、すでにある辞書・手動順位を未送信として扱う。
  // そうしないと更新後の最初のオンライン読込でremoteに黙って置き換えられる。
  conversionProfileDirty = typeof meta?.dirty === 'boolean'
    ? meta.dirty
    : Boolean(userId && conversionProfileCloudHasChanges());
  conversionProfileConflict = false;
  conversionProfileMutationGeneration = 0;
}

function persistConversionLocalProfile(userId = cloudAccount.userId) {
  try {
    localStorage.setItem(conversionProfileStorageKey(CONVERSION_DICTIONARY_KEY, userId), JSON.stringify(conversionDictionary));
    localStorage.setItem(conversionProfileStorageKey(CONVERSION_LEARNING_KEY, userId), JSON.stringify(conversionLearning));
    localStorage.setItem(conversionProfileStorageKey(CONVERSION_MANUAL_PRIORITY_KEY, userId), JSON.stringify(conversionManualPriority));
    localStorage.setItem(conversionProfileStorageKey(CONVERSION_PROFILE_REVISION_KEY, userId), String(conversionProfileRevision));
    localStorage.setItem(conversionProfileStorageKey(CONVERSION_PROFILE_META_KEY, userId), JSON.stringify({ revision: conversionProfileRevision, dirty: conversionProfileDirty }));
  } catch (err) { console.warn('[neo-math] conversion profile save failed', err); }
}

function conversionProfileCloudHasChanges(dictionary = conversionDictionary, manual = conversionManualPriority) {
  return Object.keys(dictionary.additions ?? {}).length > 0
    || Object.keys(dictionary.addedAliases ?? {}).length > 0
    || Object.keys(dictionary.deletedAliases ?? {}).length > 0
    || (dictionary.deletedCandidates ?? []).length > 0
    || Object.keys(manual.priorities ?? {}).length > 0;
}

function markConversionProfileDirty() {
  // 学習履歴だけは端末内に残すため、クラウド同期対象の辞書/手動順位を変えた
  // アカウントだけに未送信印を付ける。
  if (!cloudAccount?.userId) return;
  conversionProfileMutationGeneration += 1;
  conversionProfileDirty = true;
  persistConversionLocalProfile();
}

function conversionProfileHasChanges(dictionary = conversionDictionary, manual = conversionManualPriority, learning = conversionLearning) {
  return Object.keys(dictionary.additions ?? {}).length > 0
    || Object.keys(dictionary.addedAliases ?? {}).length > 0
    || Object.keys(dictionary.deletedAliases ?? {}).length > 0
    || (dictionary.deletedCandidates ?? []).length > 0
    || Object.keys(manual.priorities ?? {}).length > 0
    || Object.keys(learning.selections ?? {}).length > 0;
}

function claimAnonymousConversionProfile(userId) {
  let owner = null;
  try { owner = localStorage.getItem(CONVERSION_ANONYMOUS_CLAIM_KEY); }
  catch { return null; }
  if (owner && owner !== userId) return null;
  const dictionaryRaw = localStorage.getItem(CONVERSION_DICTIONARY_KEY);
  const learningRaw = localStorage.getItem(CONVERSION_LEARNING_KEY);
  const manualRaw = localStorage.getItem(CONVERSION_MANUAL_PRIORITY_KEY);
  if (!dictionaryRaw && !learningRaw && !manualRaw) return null;
  let dictionary = emptyConversionDictionaryState(); let learning = null; let manual = null;
  try { dictionary = sanitizeConversionDictionaryState(JSON.parse(dictionaryRaw || 'null')); } catch { /* ignore */ }
  const candidates = effectiveConversionCandidates(dictionary);
  try { learning = JSON.parse(learningRaw || 'null'); } catch { /* ignore */ }
  try { manual = JSON.parse(manualRaw || 'null'); } catch { /* ignore */ }
  const profile = { dictionary, learning: sanitizeLearningState(learning, candidates), manual: sanitizeManualPriorityState(manual, candidates) };
  if (!conversionProfileHasChanges(profile.dictionary, profile.manual, profile.learning)) return null;
  try { localStorage.setItem(CONVERSION_ANONYMOUS_CLAIM_KEY, userId); } catch { return null; }
  return profile;
}

function beginAccountOperation() {
  accountOperation += 1;
  accountAbortController?.abort();
  accountAbortController = new AbortController();
  return { id: accountOperation, signal: accountAbortController.signal };
}

function isCurrentAccountOperation(operation, userId = null) {
  return operation?.id === accountOperation && (!userId || cloudAccount.userId === userId);
}

function setAccountSubmitting(next) {
  accountSubmitting = next;
  document.querySelectorAll('.account-submit').forEach((button) => { button.disabled = next; });
}

function notesStorageKey() {
  return cloudAccount.userId ? `${NOTE_STORAGE_KEY}.user.${cloudAccount.userId}` : NOTE_STORAGE_KEY;
}

// 「完全に削除」でサーバ側にも物理削除を要求した記録。notesStoreとは別の小さな
// journalにする（notesStore内に混ぜると、ログイン直後の再構築処理がpendingDeletesを
// 一緒に上書き・消失させてしまいやすいため）。アカウントごとに分け、ログアウト中は
// 追跡しない（未ログインの「完全に削除」はローカルだけで完結する仕様のため）。
function pendingDeletesStorageKey(userId = cloudAccount.userId) {
  return userId ? `${NOTE_STORAGE_KEY}.pending-deletes.user.${userId}` : null;
}
function readPendingDeletes(userId = cloudAccount.userId) {
  const key = pendingDeletesStorageKey(userId);
  if (!key) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
  } catch { return []; }
}
function writePendingDeletes(ids, userId = cloudAccount.userId) {
  const key = pendingDeletesStorageKey(userId);
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* 保存できなくても致命ではない: 次回操作時に再試行できる */ }
}

const pendingDeleteRunning = new Set();
// サーバへの物理削除要求をアカウント単位で直列に流し、失敗時は次回（次の削除操作・
// 次回ログイン/セッション復元）まで持ち越して自動的に追いつかせる。ローカルの
// 「完全に削除」は常に即時実行済みなので、ここで失敗してもローカル側を巻き戻さない
// （＝ローカルは消えたまま、サーバ側にだけ後から追いつく片方向の再試行でよい。
// 逆にサーバ側だけ先に消える経路は無い＝常にローカル削除→サーバ削除の順）。
async function drainPendingDeletes(userId = cloudAccount.userId) {
  if (!userId || pendingDeleteRunning.has(userId)) return;
  pendingDeleteRunning.add(userId);
  try {
    while (cloudAccount.userId === userId) {
      const pending = readPendingDeletes(userId);
      if (!pending.length) break;
      const id = pending[0];
      try {
        await apiJson(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch {
        // 401（セッション切れ）・ネットワーク断・5xxのどれでも、ここでは判別せず
        // 単純に諦めて次の機会（次の削除操作・次回ログイン/セッション復元）に譲る。
        // journalは消さないので取りこぼしにはならない。
        break;
      }
      // 成功（既に無かった場合の deleted:false も含めて2xxはすべて「サーバに存在しない」
      // 状態への到達を意味する＝目的達成）。journalから外す。
      const remaining = readPendingDeletes(userId).filter((entry) => entry !== id);
      writePendingDeletes(remaining, userId);
    }
  } finally {
    pendingDeleteRunning.delete(userId);
  }
}

// ノートの名前は任意入力（未設定=null）。空文字・空白だけの入力もnullへ丸め、
// その場合は従来どおりnotePreview()の自動プレビューを表示する。
function sanitizeNoteTitle(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, NOTE_TITLE_MAX);
  return trimmed || null;
}

function sanitizeNoteDeletedAt(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function normalizeNotesStore(saved, { anonymous = false } = {}) {
  if (!saved || saved.version !== NOTE_STORE_VERSION || !Array.isArray(saved.notes)) {
    return { version: NOTE_STORE_VERSION, activeId: null, notes: [] };
  }
  const notes = saved.notes
    .filter((note) => note && typeof note.id === 'string' && Array.isArray(note.rows))
    .filter((note) => !anonymous || !note.claimOwner)
    .map((note) => ({
      ...note,
      revision: Number.isSafeInteger(note.revision) && note.revision >= 0 ? note.revision : 0,
      layout: normalizeNoteLayout(note.layout, note.rows),
      title: sanitizeNoteTitle(note.title),
      deletedAt: sanitizeNoteDeletedAt(note.deletedAt),
    }));
  return {
    version: NOTE_STORE_VERSION,
    // ゴミ箱入りのノートはactiveIdの復元先にしない（editorへ削除済みノートを開かせない）。
    activeId: typeof saved.activeId === 'string' && notes.some((note) => note.id === saved.activeId && !note.deletedAt) ? saved.activeId : null,
    notes,
  };
}

// 猶予期間（NOTE_TRASH_RETENTION_MS）を過ぎたゴミ箱ノートだけを物理削除する。
// 参照透過（storeを書き換えず、変更があれば新しいオブジェクトを返す）にして、
// 呼び出し側で「変わったときだけ再保存する」を判断しやすくする。
function purgeExpiredTrash(store) {
  const cutoff = Date.now() - NOTE_TRASH_RETENTION_MS;
  const kept = store.notes.filter((note) => !note.deletedAt || Date.parse(note.deletedAt) >= cutoff);
  if (kept.length === store.notes.length) return store;
  return { ...store, notes: kept, activeId: kept.some((note) => note.id === store.activeId) ? store.activeId : null };
}

function readRawNotesStore(key) {
  try { return normalizeNotesStore(JSON.parse(localStorage.getItem(key) || 'null')); }
  catch { return { version: NOTE_STORE_VERSION, activeId: null, notes: [] }; }
}

function persistRawNotesStore(key, store) {
  try {
    localStorage.setItem(key, JSON.stringify(store));
    return true;
  } catch (err) {
    console.warn('[neo-math] notes save failed', err);
    return false;
  }
}

function readNotesStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(notesStorageKey()) || 'null');
    notesStore = normalizeNotesStore(saved, { anonymous: !cloudAccount.userId });
    const purged = purgeExpiredTrash(notesStore);
    if (purged !== notesStore) { notesStore = purged; persistNotesStore(); }
  } catch (err) {
    console.warn('[neo-math] notes read failed', err);
  }
}

function hasNoteContent(values = rows.map((row) => row.mf.value)) {
  return values.some((value) => String(value || '').replace(/\\placeholder\{\}/g, '').trim().length > 0);
}

function isStoredEmptyNote(note) {
  // notesStoreに存在するID付きノートだけを「既存」と扱う。新規の空編集面は
  // saveCurrentNoteNowがそもそもnoteを作らないため、一覧や同期を増やさない。
  return typeof note?.id === 'string' && Array.isArray(note?.rows) && !hasNoteContent(note.rows);
}

function shouldSyncNote(note) {
  return hasNoteContent(note?.rows ?? []) || isStoredEmptyNote(note);
}

function notePreview(values) {
  const source = values.find((value) => String(value || '').replace(/\\placeholder\{\}/g, '').trim()) || '';
  const readable = String(source)
    .replace(/\\(left|right|dfrac|frac|sqrt|mathrm|operatorname)\b/g, '')
    .replace(/[{}\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return readable || '空の数式';
}

function makeNoteId() {
  return `note-${crypto.randomUUID()}`;
}

function persistNotesStore() {
  try {
    localStorage.setItem(notesStorageKey(), JSON.stringify(notesStore));
    return true;
  } catch (err) {
    // 保存領域が使えなくても編集を止めない。次の変更で再試行する。
    console.warn('[neo-math] notes save failed', err);
    return false;
  }
}

// 名前が付いていればそれを、無ければ従来どおり中身からの自動プレビューを表示する。
function noteDisplayTitle(note) {
  return sanitizeNoteTitle(note.title) || notePreview(note.rows);
}

function unitLabel(unitId) {
  if (unitId === ALL_UNITS_ID) return '全単元';
  return UNITS.find((entry) => entry.id === unitId)?.label ?? '';
}

// 設定モーダルの検索（部分一致・大小無視、input即時反映）と操作感を揃える。
// 対象は表示名（名前があればそれ、無ければ自動プレビュー）と行の生LaTeX本文。
function noteMatchesFilter(note, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = `${noteDisplayTitle(note)} ${note.rows.join(' ')}`.toLowerCase();
  return haystack.includes(q);
}

function buildNoteListItem(note) {
  const item = document.createElement('div');
  item.className = 'note-list-item';
  item.dataset.noteId = note.id;
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.setAttribute('aria-current', String(note.id === notesStore.activeId));
  const title = document.createElement('b');
  title.textContent = noteDisplayTitle(note);
  const meta = document.createElement('small');
  const date = new Date(note.updatedAt);
  const time = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  meta.textContent = [unitLabel(note.unitId), time].filter(Boolean).join(' · ');
  const actions = document.createElement('div');
  actions.className = 'note-item-actions';
  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'note-item-action';
  renameBtn.textContent = '名前';
  renameBtn.setAttribute('aria-label', `${noteDisplayTitle(note)}の名前を変更`);
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'note-item-action note-item-action-delete';
  deleteBtn.textContent = '削除';
  deleteBtn.setAttribute('aria-label', `${noteDisplayTitle(note)}を削除（ゴミ箱へ）`);
  // action系ボタンはpointerdown段階でstopPropagationし、親item（開く操作）の
  // クリック判定に巻き込まれないようにする（既存のrow-delete等と同じ作法）。
  [renameBtn, deleteBtn].forEach((btn) => btn.addEventListener('pointerdown', (event) => event.stopPropagation()));
  renameBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); beginRenameNote(item, note); });
  deleteBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); deleteNote(note.id); });
  actions.append(renameBtn, deleteBtn);
  item.append(title, meta, actions);
  const open = () => loadNote(note.id);
  item.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('.note-item-actions, .note-item-rename-input')) return; open(); });
  item.addEventListener('keydown', (event) => {
    if (event.target !== item) return; // 名前入力欄・操作ボタン自身のキー操作は奪わない
    if (event.code === 'Enter' || event.code === 'Space') { event.preventDefault(); open(); }
  });
  return item;
}

// 名前を変更する。<b>を一時的に<input>へ差し替えるだけの軽量な行内編集にして、
// 別モーダルを増やさない（既存の一覧popoverの操作感のまま完結させる）。
function beginRenameNote(item, note) {
  if (item.querySelector('.note-item-rename-input')) return;
  const titleEl = item.querySelector('b');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'note-item-rename-input';
  input.maxLength = NOTE_TITLE_MAX;
  input.value = sanitizeNoteTitle(note.title) || '';
  input.placeholder = notePreview(note.rows);
  input.setAttribute('aria-label', 'ノートの名前');
  let settled = false;
  const commit = () => { if (settled) return; settled = true; renameNote(note.id, input.value); };
  const cancel = () => { if (settled) return; settled = true; renderNotesList(); };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.code === 'Enter') { event.preventDefault(); commit(); }
    else if (event.code === 'Escape') { event.preventDefault(); cancel(); }
  });
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('pointerdown', (event) => event.stopPropagation());
  input.addEventListener('blur', commit);
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function renameNote(id, rawTitle) {
  const note = notesStore.notes.find((entry) => entry.id === id);
  if (!note) return;
  // 名前変更は内容編集ではないためupdatedAtは動かさない（一覧の並び順を崩さない）。
  note.title = sanitizeNoteTitle(rawTitle);
  persistNotesStore();
  renderNotesList();
  // 段階4: 名前もクラウド同期に乗せる（サーバは0005マイグレーションでtitle列を持つ）。
  queueCloudSave(note);
}

// 削除＝即物理削除ではなくdeletedAtを立てるソフトデリート。ゴミ箱から復元・
// 完全削除できるようにし、「間違って消したものが戻らない」を防ぐ。
function deleteNote(id) {
  const note = notesStore.notes.find((entry) => entry.id === id);
  if (!note || note.deletedAt) return;
  note.deletedAt = new Date().toISOString();
  persistNotesStore();
  // 段階4: ソフトデリートもクラウド同期に乗せる。他端末でも消えた状態のまま復活しない。
  queueCloudSave(note);
  if (notesStore.activeId === id) {
    // 表示中のノートを消した場合、削除済みノートをそのまま編集面に残さない。
    // 直近の生存ノートへ切り替えるか、無ければ新規ノートを開く。
    clearTimeout(noteSaveTimer);
    const next = [...notesStore.notes]
      .filter((entry) => !entry.deletedAt)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (next) loadNote(next.id, true, false);
    else createNewNote(noteUnitScope);
  } else {
    renderNotesList();
  }
}

function restoreNote(id) {
  const note = notesStore.notes.find((entry) => entry.id === id);
  if (!note) return;
  note.deletedAt = null;
  persistNotesStore();
  renderNotesList();
  // 段階4: 復元もクラウド同期に乗せる。
  queueCloudSave(note);
}

// ゴミ箱からの完全削除。これだけは本当に取り消せないため、実行前に確認を挟む
// （ソフトデリート側の「削除」には確認を挟まない代わりに、ここで最後の安全弁を置く）。
function purgeNoteForever(id) {
  const note = notesStore.notes.find((entry) => entry.id === id);
  if (!note) return;
  const label = noteDisplayTitle(note);
  if (!confirm(`「${label}」を完全に削除します。この操作は取り消せません。よろしいですか？`)) return;
  notesStore.notes = notesStore.notes.filter((entry) => entry.id !== id);
  if (notesStore.activeId === id) notesStore.activeId = null;
  persistNotesStore();
  renderNotesList();
  // 未ログインならローカルだけで完結する（従来どおり）。ログイン中は、これまで
  // クラウドへ保存されていたかもしれないノートをサーバ側でも物理削除しないと、
  // ソフトデリート行として残り続けて100件の保存枠を占有し続けてしまう。
  // ローカル削除はここで既に確定済みなので、以降のサーバ削除が失敗しても
  // ローカルを復元しない（片方向の追いつき）。失敗はjournalに残して次回
  // （次の削除操作・次回ログイン/セッション復元）に自動で再試行する。
  if (cloudAccount.userId) {
    const queue = cloudQueues.get(cloudAccount.userId);
    queue?.dirty.delete(id); // 直前のソフトデリート保存がまだ未送信なら、二重送信せず先に取り下げる。
    const pending = readPendingDeletes();
    if (!pending.includes(id)) writePendingDeletes([...pending, id]);
    void drainPendingDeletes();
  }
}

function buildTrashListItem(note) {
  const item = document.createElement('div');
  item.className = 'note-list-item note-list-item-trash';
  item.dataset.noteId = note.id;
  const title = document.createElement('b');
  title.textContent = noteDisplayTitle(note);
  const meta = document.createElement('small');
  const deleted = new Date(note.deletedAt);
  meta.textContent = Number.isNaN(deleted.getTime()) ? '' : `削除: ${deleted.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  const actions = document.createElement('div');
  actions.className = 'note-item-actions';
  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'note-item-action';
  restoreBtn.textContent = '元に戻す';
  restoreBtn.addEventListener('click', () => restoreNote(note.id));
  const purgeBtn = document.createElement('button');
  purgeBtn.type = 'button';
  purgeBtn.className = 'note-item-action note-item-action-delete';
  purgeBtn.textContent = '完全に削除';
  purgeBtn.addEventListener('click', () => purgeNoteForever(note.id));
  actions.append(restoreBtn, purgeBtn);
  item.append(title, meta, actions);
  return item;
}

function renderNotesList() {
  const list = document.getElementById('notes-list-items');
  const trashToggle = document.getElementById('notes-trash-toggle');
  const trashList = document.getElementById('notes-trash-list');
  if (!list) return;
  list.innerHTML = '';
  const active = notesStore.notes.filter((note) => !note.deletedAt);
  const trashed = notesStore.notes.filter((note) => note.deletedAt);
  const ordered = active
    .filter((note) => noteMatchesFilter(note, notesFilterQuery))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!ordered.length) {
    const empty = document.createElement('p');
    empty.className = 'note-list-empty';
    empty.textContent = active.length ? '一致するノートがありません' : 'まだ保存したノートはありません';
    list.appendChild(empty);
  } else {
    for (const note of ordered) list.appendChild(buildNoteListItem(note));
  }
  if (trashToggle) {
    trashToggle.textContent = `ゴミ箱（${trashed.length}）`;
    trashToggle.setAttribute('aria-expanded', String(notesTrashOpen));
  }
  if (trashList) {
    trashList.hidden = !notesTrashOpen;
    trashList.innerHTML = '';
    if (notesTrashOpen) {
      if (!trashed.length) {
        const empty = document.createElement('p');
        empty.className = 'note-list-empty';
        empty.textContent = 'ゴミ箱は空です';
        trashList.appendChild(empty);
      } else {
        const orderedTrash = [...trashed].sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
        for (const note of orderedTrash) trashList.appendChild(buildTrashListItem(note));
      }
    }
  }
}

function saveCurrentNoteNow() {
  const current = notesStore.notes.find((entry) => entry.id === notesStore.activeId);
  // 新規の完全な空ノートは一覧を増やさない。既存ノートなら、カメラだけの変更も保存する。
  if (restoringNote || (!hasNoteContent() && !current)) return false;
  const now = new Date().toISOString();
  const values = rows.map((row) => row.mf.value);
  let note = current;
  if (!note) {
    note = { id: makeNoteId(), createdAt: now, updatedAt: now, unitId: noteUnitScope, rows: [], revision: 0, title: null, deletedAt: null };
    notesStore.notes.push(note);
    notesStore.activeId = note.id;
  }
  note.rows = values;
  note.layout = noteLayoutSnapshot();
  note.unitId = noteUnitScope;
  note.updatedAt = now;
  persistNotesStore();
  renderNotesList();
  queueCloudSave(note);
  // クラウド未ログインでは queueCloudSave が何もしないため、保存済みの表示は
  // ここで出す（3. 保存された感）。ログイン時はクラウド同期側の状態表示を優先する。
  if (!cloudAccount.userId) updateCloudStatus('local-saved');
  return true;
}

function scheduleNoteSave() {
  if (restoringNote) return;
  refreshReviewStaleState();
  clearTimeout(noteSaveTimer);
  // 保存はNOTE_SAVE_DELAY_MSだけ遅延書き込みなので、その間は「保存中」を出す
  // （3. 保存された感。書き込み自体はsaveCurrentNoteNow側で従来どおり正しく動く）。
  if (!cloudAccount.userId) updateCloudStatus('local-saving');
  noteSaveTimer = setTimeout(() => saveCurrentNoteNow(), NOTE_SAVE_DELAY_MS);
}

function clearRowsForNote() {
  conversionOpen = false;
  cancelAnimationFrame(restoreFocusFrame);
  restoreFocusFrame = 0;
  clearTimeout(restoreFocusTimer);
  restoreFocusTimer = 0;
  // Shadow DOM内のkeyboard sinkにフォーカスが残ったままmath-fieldを取り除くと、
  // MathLiveが切断後のonBlurで内部optionsを読んで例外になる。接続中に先にblurする。
  const focusedField = activeRow()?.mf;
  const focusedSink = focusedField?.shadowRoot?.querySelector('.ML__keyboard-sink');
  // dialogが先にfocusを奪った場合でも、MathLive内部には選択/keyboard sinkの
  // セッションが残ることがある。接続中のfieldへ常にblurを通知してから破棄する。
  // これを省くと次のfieldをfocusした瞬間に、切断済みモデルのonBlurが走る。
  if (focusedSink instanceof HTMLElement) focusedSink.blur();
  if (focusedField?.isConnected) focusedField.blur();
  rows.forEach((row) => row.caret?.remove());
  rows.splice(0, rows.length);
  blockEl.replaceChildren();
  activeRowIndex = 0;
  // ノート切り替えで消えるrowへの参照を残さない（矩形選択・drag中状態・貼り付け
  // オフセットの起点は、このノートに固有の一時状態のため）。
  selectedRows = new Set();
  canvasSelectDrag = null;
  removeSelectBoxEl();
  blockDrag = null;
}

function loadNote(id, restoreFocus = true, saveCurrent = true) {
  const note = notesStore.notes.find((entry) => entry.id === id);
  if (!note) return;
  clearTimeout(noteSaveTimer);
  if (saveCurrent) saveCurrentNoteNow();
  restoringNote = true;
  clearRowsForNote();
  const layout = normalizeNoteLayout(note.layout, note.rows);
  layoutMode = layout.mode;
  canvasCamera = layout.camera;
  const blocks = layout.mode === 'canvas'
    ? layout.blocks
    : (note.rows.length
      ? note.rows.map((latex, index) => ({ id: layout.blockIds[index], latex, x: 112, y: 96 + index * 104 }))
      : [{ id: makeBlockId(), latex: '', x: 112, y: 96 }]);
  blocks.forEach((item) => createRow(false, String(item.latex || ''), item));
  notesStore.activeId = note.id;
  if (UNIT_IDS.has(note.unitId)) {
    noteUnitScope = note.unitId;
    setCurrentUnit(note.unitId);
  }
  restoringNote = false;
  renderLayoutMode();
  persistNotesStore();
  renderNotesList();
  // ノートを跨いで取り消し履歴を持ち越さない（別ノートを開いた後のCtrl+Zが
  // 今のノートを別内容で上書きしてしまうのを防ぐ）。
  initHistory();
  cancelAnimationFrame(restoreFocusFrame);
  restoreFocusFrame = requestAnimationFrame(() => {
    const row = rows[0];
    const accountDialog = document.getElementById('account-dialog');
    if (!row || !row.mf.isConnected || notesStore.activeId !== note.id || accountDialog?.open) return;
    row.mf.position = row.mf.lastOffset;
    reconcileStack(row);
    activeRowIndex = 0;
    if (restoreFocus) focusActiveRow();
    renderBreadcrumb();
  });
}

function createNewNote(unitId = noteUnitScope) {
  // サーバー側は内容の有無に関わらず100件を上限にする。端末に退避した
  // 101件目を再び増やさないため、ここもストア件数で同じ境界を使う。
  if (cloudAccount.userId && notesStore.notes.length >= CLOUD_NOTE_LIMIT) {
    updateCloudStatus('limit');
    return false;
  }
  clearTimeout(noteSaveTimer);
  saveCurrentNoteNow();
  noteUnitScope = UNIT_IDS.has(unitId) ? unitId : ALL_UNITS_ID;
  setCurrentUnit(noteUnitScope);
  notesStore.activeId = null;
  clearRowsForNote();
  layoutMode = 'rows';
  canvasCamera = { x: 72, y: 54, zoom: 1 };
  const row = createRow(false);
  activeRowIndex = rows.length - 1;
  stats.keystrokes = 0;
  stats.startTime = performance.now();
  document.getElementById('stat-keystrokes').textContent = '0';
  renderElapsed();
  persistNotesStore();
  renderNotesList();
  renderLayoutMode();
  renderBreadcrumb();
  // 新規作成直後の1打目をボタンへ落とさず、mount後にMathLiveが旧fieldへ戻す
  // focusもここで吸収する。
  claimRowFocus(row);
  initHistory();
}

let newNoteUnitChoice = ALL_UNITS_ID;
let newNoteSubjectChoice = ALL_UNITS_ID;
let newNoteOpener = null;
let guideUnitChoice = ALL_UNITS_ID;
let guideUnitSubjectChoice = ALL_UNITS_ID;
let guideUnitOpener = null;

// 科目→単元の二段階。全単元だけは先頭に常設し、22件を一画面へ並べて
// スクロールさせない。選択結果の確定は呼び出し元に任せる。
function renderUnitModalChoices({ subjectId, unitId, subjectContainerId, unitContainerId, onSubject, onUnit }) {
  const subjects = document.getElementById(subjectContainerId);
  const units = document.getElementById(unitContainerId);
  if (!subjects || !units) return;
  subjects.replaceChildren();
  units.replaceChildren();
  const subjectButton = (id, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'unit-modal-subject-button';
    button.dataset.subjectId = id;
    button.textContent = label;
    button.setAttribute('aria-pressed', String(subjectId === id));
    button.addEventListener('click', () => onSubject(id));
    subjects.append(button);
  };
  subjectButton(ALL_UNITS_ID, '全単元');
  for (const subject of SUBJECTS) subjectButton(subject.id, subject.label);
  if (subjectId === ALL_UNITS_ID) return;
  const subject = SUBJECTS.find((entry) => entry.id === subjectId);
  for (const unit of subject?.units ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'new-note-unit-button';
    button.dataset.unitId = unit.id;
    button.textContent = unit.label;
    button.setAttribute('aria-pressed', String(unitId === unit.id));
    button.addEventListener('click', () => onUnit(unit.id));
    units.append(button);
  }
}

function renderNewNoteUnitChoices() {
  renderUnitModalChoices({
    subjectId: newNoteSubjectChoice,
    unitId: newNoteUnitChoice,
    subjectContainerId: 'new-note-subject-choice',
    unitContainerId: 'new-note-unit-choice',
    onSubject: (id) => {
      newNoteSubjectChoice = id;
      newNoteUnitChoice = id === ALL_UNITS_ID ? ALL_UNITS_ID : null;
      renderNewNoteUnitChoices();
      document.querySelector(`#new-note-subject-choice [data-subject-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    },
    onUnit: (id) => {
      newNoteUnitChoice = id;
      renderNewNoteUnitChoices();
      document.querySelector(`#new-note-unit-choice [data-unit-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    },
  });
  const create = document.getElementById('new-note-create');
  if (create) create.disabled = !newNoteUnitChoice;
}

function openNewNoteDialog() {
  const dialog = document.getElementById('new-note-dialog');
  if (!dialog) return;
  newNoteOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  newNoteSubjectChoice = ALL_UNITS_ID;
  newNoteUnitChoice = ALL_UNITS_ID;
  renderNewNoteUnitChoices();
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[data-subject-id="all"]')?.focus();
}

function closeNewNoteDialog({ restoreFocus = true } = {}) {
  const dialog = document.getElementById('new-note-dialog');
  if (dialog?.open) dialog.close();
  if (restoreFocus && newNoteOpener?.isConnected) newNoteOpener.focus({ preventScroll: true });
  newNoteOpener = null;
}

function renderGuideUnitChoices() {
  renderUnitModalChoices({
    subjectId: guideUnitSubjectChoice,
    unitId: guideUnitChoice,
    subjectContainerId: 'guide-unit-subject-choice',
    unitContainerId: 'guide-unit-choice',
    onSubject: (id) => {
      guideUnitSubjectChoice = id;
      guideUnitChoice = id === ALL_UNITS_ID ? ALL_UNITS_ID : null;
      renderGuideUnitChoices();
      document.querySelector(`#guide-unit-subject-choice [data-subject-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    },
    onUnit: (id) => {
      guideUnitChoice = id;
      setCurrentUnit(id);
      closeGuideUnitDialog({ restoreFocus: false });
      focusActiveRow();
    },
  });
}

function openGuideUnitDialog() {
  // 個別ノートの単元はノートの範囲そのものなので、ここからは変えない。
  if (noteUnitScope !== ALL_UNITS_ID) return;
  const dialog = document.getElementById('guide-unit-dialog');
  if (!dialog) return;
  guideUnitOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // 開くたびに「全単元」から始める。Escで閉じた場合は実際のガイドを変更しない。
  guideUnitSubjectChoice = ALL_UNITS_ID;
  guideUnitChoice = ALL_UNITS_ID;
  renderGuideUnitChoices();
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[data-subject-id="all"]')?.focus();
}

function closeGuideUnitDialog({ restoreFocus = true } = {}) {
  const dialog = document.getElementById('guide-unit-dialog');
  if (dialog?.open) dialog.close();
  if (restoreFocus && guideUnitOpener?.isConnected) guideUnitOpener.focus({ preventScroll: true });
  guideUnitOpener = null;
}

function toggleNotesList(open) {
  const list = document.getElementById('notes-list');
  const button = document.getElementById('notes-toggle');
  if (!list || !button) return;
  const next = open ?? list.hidden;
  list.hidden = !next;
  button.setAttribute('aria-expanded', String(next));
  button.setAttribute('aria-label', next ? '過去のノートを閉じる' : '過去のノートを開く');
  if (next) renderNotesList();
}

// ---------------------------------------------------------------------------
// 書き出し（LaTeX） — 段階3
// MathLiveのmath-field.value は元々LaTeX文字列そのもの（取り消し履歴・クラウド
// 保存など既存コードも一貫してこの前提で latex: row.mf.value を使っている）。
// よって「LaTeXへ変換する」処理は不要で、既に持っている値をそのまま書き出すだけでよい。
// ---------------------------------------------------------------------------

function flashButtonFeedback(button, ok, { okText = 'コピーしました', failText = '失敗しました', holdMs = 1100 } = {}) {
  if (!button) return;
  const original = button.textContent;
  button.textContent = ok ? okText : failText;
  button.disabled = true;
  setTimeout(() => { button.textContent = original; button.disabled = false; }, holdMs);
}

async function copyRowLatexToClipboard(row) {
  const latex = String(row?.mf?.value || '');
  if (!latex) return false;
  try { await navigator.clipboard.writeText(latex); return true; }
  catch (err) { console.warn('[neo-math] latex copy failed', err); return false; }
}

// 現在の編集面を書き出し順に並べたLaTeX配列を返す。canvasレイアウトは自由配置の
// ため「上→下、同じ高さなら左→右」という一般的な読み順に並べ替え、座標情報自体は
// 捨てる（レポート等へ持ち出す用途では座標に意味がなく、そのまま持ち出しても
// 貼り付け先で解釈できないため）。行モードはもともとの並び=読み順なのでそのまま使う。
function currentNoteOrderedLatex() {
  const blocks = rows
    .map((row, index) => ({ latex: String(row.mf.value || ''), ...rowWorldPosition(row, index) }))
    .filter((block) => block.latex.replace(/\\placeholder\{\}/g, '').trim());
  if (layoutMode === 'canvas') blocks.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return blocks.map((block) => block.latex);
}

// 1式ずつ独立したdisplay math（\[ ... \]）として書き出す。LaTeX文書にそのまま
// 貼れる形を優先した判断（区切りが不要なら呼び出し側で単純な文字列置換で外せる）。
function noteLatexExportText() {
  return currentNoteOrderedLatex().map((latex) => `\\[ ${latex} \\]`).join('\n\n');
}

async function copyNoteLatexToClipboard() {
  const text = noteLatexExportText();
  if (!text) return false;
  try { await navigator.clipboard.writeText(text); return true; }
  catch (err) { console.warn('[neo-math] note latex copy failed', err); return false; }
}

function downloadNoteLatex() {
  const text = noteLatexExportText();
  if (!text) return false;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  const current = notesStore.notes.find((entry) => entry.id === notesStore.activeId);
  const label = current ? noteDisplayTitle(current) : notePreview(rows.map((row) => row.mf.value));
  const safeName = label.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60) || 'shikitype-note';
  link.download = `${safeName}.tex`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
  return true;
}

function toggleExportMenu(open) {
  const menu = document.getElementById('export-note-menu');
  const button = document.getElementById('export-note-toggle');
  if (!menu || !button) return;
  const next = open ?? menu.hidden;
  menu.hidden = !next;
  button.setAttribute('aria-expanded', String(next));
}

function isEmptyMathBlock(row) {
  return !String(row?.mf?.value || '').replace(/\\placeholder\{\}/g, '').trim();
}

function removeEmptyRow(row, { requireEmpty = true, skipHistory = false } = {}) {
  const index = rows.indexOf(row);
  if (index < 0 || (requireEmpty && !isEmptyMathBlock(row))) return false;
  // 行モードには常に入力先を1つ残す。キャンバスは0 blockを正規の状態として保存できる。
  if (layoutMode === 'rows' && rows.length <= 1) return false;
  closeConversion(row, { clear: true, focus: false });
  const sink = row.mf.shadowRoot?.querySelector('.ML__keyboard-sink');
  if (sink instanceof HTMLElement) sink.blur();
  if (row.mf.isConnected) row.mf.blur();
  row.caret?.remove();
  row.wrap.remove();
  rows.splice(index, 1);
  selectedRows.delete(row);
  const nextIndex = rows.length ? Math.max(0, index - 1) : -1;
  activeRowIndex = nextIndex;
  if (nextIndex >= 0) {
    const next = rows[nextIndex];
    claimRowFocus(next);
  }
  renderBreadcrumb();
  // skipHistory: 選択ブロックの一括削除(deleteSelectedRows)からは行ごとに呼ばれるため、
  // 呼び出し側で1回だけscheduleNoteSave()+commitHistoryBoundary()する（1操作=1取り消し単位）。
  if (!skipHistory) { scheduleNoteSave(); commitHistoryBoundary(); }
  return true;
}

function createRow(focus, latex = '', position = null, insertIndex = rows.length) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const mf = document.createElement('math-field');
  mf.setAttribute('math-virtual-keyboard-policy', 'manual'); // 仮想キーボードを出さない
  mf.setAttribute('default-mode', 'inline-math'); // ∫ の上下限を記号の右肩・右下に出すため inline。
  // 分数だけは \dfrac で display 相当の大きさに組む（下の openNfrac / openAfrac 参照）
  wrap.appendChild(mf);
  const safeIndex = Math.max(0, Math.min(rows.length, Number.isInteger(insertIndex) ? insertIndex : rows.length));
  blockEl.insertBefore(wrap, rows[safeIndex]?.wrap ?? null);
  // menuItems はマウント後にしか触れない（マウント前に代入すると "Mathfield not mounted" で落ちる）。
  // MathLive 既定のハンバーガーメニューを消す＝操作はキーだけで完結させる方針のため。
  mf.menuItems = [];
  if (latex) mf.value = latex;

  const row = new RowState(mf, position?.id);
  row.wrap = wrap;
  // 外部からの明示的なmath-field.focus()（テスト/APIを含む）は、新しい入力先の
  // 指定として扱う。一方、MathLiveがshadow sinkへ戻す内部focusはここを通らない。
  const nativeMathFieldFocus = mf.focus.bind(mf);
  row.focusMathField = (...args) => nativeMathFieldFocus(...args);
  mf.focus = (...args) => {
    if (!row.appClaimingFocus) {
      rowFocusClaim += 1;
      protectedFocusRow = null;
    }
    return nativeMathFieldFocus(...args);
  };
  // SHIKITYPE変換中はMathLiveのkeyboard sinkを入力先にしない。非編集のproxyへ
  // focusを置くことで、OSのかなIMEは起動せず、物理key codeだけを専用IMEへ渡せる。
  const inputProxy = document.createElement('div');
  inputProxy.className = 'row-input-proxy';
  inputProxy.tabIndex = 0;
  inputProxy.setAttribute('role', 'textbox');
  inputProxy.setAttribute('aria-label', '数式を入力');
  inputProxy.setAttribute('aria-readonly', 'true');
  row.inputProxy = inputProxy;
  wrap.appendChild(inputProxy);
  const caret = document.createElement('i');
  caret.className = 'conversion-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.hidden = true;
  row.caret = caret;
  // fixed座標のcaretをtransformされるcanvas blockの子にすると、CSS transformが
  // fixed containing blockになり座標が二重に掛かる。body上のoverlayに置くことで
  // 行/canvas/zoomすべてでviewport座標を一意にする。
  document.body.appendChild(caret);
  rows.splice(safeIndex, 0, row);
  setRowWorldPosition(row, position, safeIndex);
  createConversionPanel(row, wrap);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'row-delete';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'この数式ブロックを削除');
  remove.title = 'この数式ブロックを削除';
  remove.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); });
  remove.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); removeEmptyRow(row, { requireEmpty: false }); });
  wrap.appendChild(remove);

  // ブロック単位のLaTeXコピー（段階3最優先要件）。行モード・canvasモード両方で
  // 常に見えるようにする（row-deleteは行モードでは隠すが、こちらは書き出し用途の
  // 一次操作なので隠さない。段階2振り返りで「発見しにくいジェスチャー」を残した
  // 反省を踏まえ、ここは最初からボタンで出す）。
  const copyLatex = document.createElement('button');
  copyLatex.type = 'button';
  copyLatex.className = 'row-copy-latex';
  copyLatex.textContent = 'TeX';
  copyLatex.setAttribute('aria-label', 'この数式のLaTeXをコピー');
  copyLatex.title = 'この数式のLaTeXをコピー';
  copyLatex.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); });
  copyLatex.addEventListener('click', async (event) => {
    event.preventDefault(); event.stopPropagation();
    const ok = await copyRowLatexToClipboard(row);
    flashButtonFeedback(copyLatex, ok, { okText: '済', failText: '空' });
  });
  wrap.appendChild(copyLatex);

  // canvasでのブロックdrag移動。event.target===wrapのときだけ、つまり数式欄・
  // 削除ボタン・変換パネルなど「wrapの子要素自身」がクリックされた場合を除く、
  // wrap自身の余白（左の番号ラベル・右上の削除ボタン周りの空きなど）を掴んだ
  // ときだけ開始する。これによりキャレット位置決め・削除ボタン・候補選択などの
  // 既存操作を一切奪わずに、blockそのものを掴む操作を追加できる。
  wrap.addEventListener('pointerdown', (event) => {
    if (layoutMode !== 'canvas' || event.target !== wrap) return;
    if (event.pointerType !== 'touch' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    startBlockDrag(row, event);
  });

  mf.addEventListener('pointerdown', () => {
    // 直前の行ではなく、ユーザーが直接クリックした行を優先する。
    rowFocusClaim += 1;
    protectedFocusRow = null;
    // 矩形選択の直後でも、行を直接クリックした時点で「選択のままDelete/Backspace」の
    // 判定は終わり。以降のDelete/Backspaceはこの行の通常編集として扱う。
    selectionFocusOverride = false;
    const currentIndex = rows.indexOf(row);
    if (currentIndex >= 0) activeRowIndex = currentIndex;
  });
  mf.addEventListener('focusin', () => {
    const currentIndex = rows.indexOf(row);
    if (currentIndex < 0) return;
    // 変換数式ではMathLiveのsink focusは「行選択」ではない。専用IMEの入力先は
    // proxyであり、行選択はproxy focus・pointerup・新規作成・行移動だけが決める。
    // これでmount後の旧sink focusがactive rowを恒久的に書き換えない。
    if (isShikitypeTransformLayer() && !isNativeTextEntry(row)) {
      scheduleConversionCaret(row);
      if (activeRow() === row) requestAnimationFrame(() => {
        if (activeRow() === row && !isNativeTextEntry(row)) row.inputProxy?.focus({ preventScroll: true });
      });
      return;
    }
    // row生成直後のMathLive内部focusは、明示的に選んだ入力先を上書きしない。
    if (protectedFocusRow && protectedFocusRow !== row) return;
    activeRowIndex = currentIndex;
    renderBreadcrumb();
    if (isShikitypeTransformLayer() && !row.nativeTextOpen && row.stack[row.stack.length - 1]?.kind !== 'text') requestAnimationFrame(() => {
      if (activeRow() === row && !row.nativeTextOpen && row.stack[row.stack.length - 1]?.kind !== 'text') row.inputProxy?.focus({ preventScroll: true });
    });
  });
  inputProxy.addEventListener('focus', () => {
    const currentIndex = rows.indexOf(row);
    if (currentIndex < 0) return;
    activeRowIndex = currentIndex;
    renderBreadcrumb();
    scheduleConversionCaret(row);
    if (isShikitypeTransformLayer()) openConversion(row, false);
  });
  // 数式上のクリックは先にMathLiveへ渡してキャレット位置を更新し、pointerup時に
  // 読み入力面へ戻す。以後のOSかなIMEは一貫して専用inputが受け、数式欄へ混ざらない。
  mf.addEventListener('pointerup', () => {
    if (!isShikitypeTransformLayer()) return;
    const currentIndex = rows.indexOf(row);
    if (currentIndex < 0) return;
    activeRowIndex = currentIndex;
    openConversion(row, false);
    // MathLiveがpointerupでキャレット位置を確定した後、同じ行の非編集proxyへ戻す。
    // rAFは別行への移動が起きた場合にactiveRow判定で無効化する。
    requestAnimationFrame(() => {
      if (activeRow() === row) row.inputProxy?.focus({ preventScroll: true });
    });
  });
  mf.addEventListener('input', () => { scheduleNoteSave(); scheduleHistoryCommit(); });

  // IME 遮断（数式ブロック）: compositionstart 経路は keydown を迂回するため個別に塞ぐ
  attachImeGuard(row);

  if (focus) {
    requestAnimationFrame(() => {
      // createRow() を呼んだ時点では、呼び出し元がこのrowをactiveにする前でも
      // ある。後続操作が別rowを選んだ場合には、その古い予約を無効にする。
      if (activeRow() !== row || !row.mf.isConnected) return;
      claimRowFocus(row);
    });
  }
  return row;
}

function newRowAfterActive() {
  // 開いたままのスロットは全部閉じてから行を変える。
  // 行を変える＝その行を書き終えたということなので、閉じ忘れを次の行へ持ち越さない。
  const cur = activeRow();
  if (cur) {
    let guard = 0;
    while (cur.stack.length > 0 && guard++ < 64) closeOneLevel(cur);
  }
  const position = layoutMode === 'canvas' && cur
    ? { x: rowWorldPosition(cur).x, y: rowWorldPosition(cur).y + 104 }
    : null;
  const insertIndex = layoutMode === 'rows' && cur ? activeRowIndex + 1 : rows.length;
  const row = createRow(false, '', position, insertIndex);
  // activeRowIndex は focusin で更新されるが、focus() は rAF 越しで遅れる。
  // その間に打鍵が来ると前の行へ入ってしまうので、ここで同期的に切り替えておく。
  claimRowFocus(row);
  if (layoutMode === 'canvas') fitCanvasRowsToViewport();
  commitHistoryBoundary();
  return row;
}

// ---------------------------------------------------------------------------
// 取り消し・やり直し（Undo/Redo）— 汎用の操作履歴スタック
// ---------------------------------------------------------------------------
// 設計方針:
// - 機能ごとに履歴を持たず、「編集操作の直後の完全な状態」をスナップショットとして
//   1本のスタックへ積む。ブロック複製・コピー貼り付け・範囲選択削除など後続の段階の
//   操作も、その操作の後で markHistoryDirty() + commitHistoryNow()（＝下の
//   commitHistoryBoundary()）を呼ぶだけでこの履歴へ乗る。個別の逆操作（delta）を
//   持たないので、新しい操作の種類が増えても取り消し側の実装を増やさなくてよい。
// - スナップショットの復元は loadNote() が既に使っている「latex+座標の配列から行を
//   再構築する」経路を再利用する。ブロック数が変わらない取り消し（打鍵単位の内容変更・
//   将来のブロック移動）は既存のMathLive要素へ値と座標を書き戻すだけにして、頻度の
//   高い操作を軽く保つ。ブロック数が変わる取り消し（追加・削除）だけ、loadNote()と同じ
//   「全消し→再構築」を使う。
// - 連続した文字入力は毎打鍵では戻さない。UNDO_COALESCE_MS（600ms）の無操作、または
//   ブロック追加・削除・候補確定などの区切り操作が起きた時点でひとつの取り消し単位として
//   確定する。600msは「一続きの入力を打ち終えて一息つく間隔」の目安（連続する打鍵の
//   間隔より十分長く、次の操作を待たされている感覚も出ない）。
// - canvasの視点移動（パン・ズーム）は編集ではないため、スナップショットにも履歴にも
//   含めない（captureHistorySnapshot() は camera を持たない）。
const UNDO_COALESCE_MS = 600;
const HISTORY_LIMIT = 200;
let historyStack = [];
let historyIndex = -1;
let historyDirty = false; // 直近のスナップショット以降、未確定の変更があるか
let historyCommitTimer = null;
let applyingHistorySnapshot = false; // 復元中はこの復元自体を新しい操作として記録しない

function captureHistorySnapshot() {
  return {
    // layoutMode（行/キャンバス表示）は編集内容ではなく「今どちらを見ているか」という
    // 表示状態。captureはしてもapplyHistorySnapshot側では書き戻さない（下のコメント参照）。
    // カメラのpan/zoomをスナップショットに含めないのと同じ理由。
    layoutMode,
    activeIndex: activeRowIndex,
    position: activeRow()?.mf?.position ?? 0,
    blocks: rows.map((row, index) => ({ id: row.id, latex: String(row.mf.value || ''), ...rowWorldPosition(row, index) })),
  };
}

// ノートの読込・新規作成のたびに呼ぶ。ノートをまたいで履歴を持ち越すと、別ノートを
// 開いた後のCtrl+Zが今開いているノートを別ノートの内容で上書きしてしまうため。
function initHistory() {
  clearTimeout(historyCommitTimer);
  historyCommitTimer = null;
  historyStack = [captureHistorySnapshot()];
  historyIndex = 0;
  historyDirty = false;
}

function markHistoryDirty() {
  if (applyingHistorySnapshot) return;
  historyDirty = true;
  refreshReviewStaleState();
}

// 打鍵ごとの細かい変更はデバウンスでまとめる。区切り操作（ブロック追加/削除、候補確定、
// 将来のブロック移動）は呼び出し側で commitHistoryBoundary() を使い、まとめの単位を
// 強制的に閉じる。
function scheduleHistoryCommit() {
  if (applyingHistorySnapshot) return;
  markHistoryDirty();
  clearTimeout(historyCommitTimer);
  historyCommitTimer = setTimeout(commitHistoryNow, UNDO_COALESCE_MS);
}

function commitHistoryNow() {
  clearTimeout(historyCommitTimer);
  historyCommitTimer = null;
  if (!historyDirty) return;
  historyDirty = false;
  const snapshot = captureHistorySnapshot();
  // MathLiveの'input'イベントは値の変更より後（マイクロタスク/rAF）で届くことがあり、
  // commitHistoryBoundary()で既に確定させた内容と同じ状態への「二重通知」になる。
  // 直前と中身が同じスナップショットは積まない（=空の取り消し単位を作らない）。
  const top = historyStack[historyIndex];
  if (top && JSON.stringify(top) === JSON.stringify(snapshot)) return;
  // 取り消してからの再編集＝進んだ先（redo対象）を捨ててから積む。
  historyStack = historyStack.slice(0, historyIndex + 1);
  historyStack.push(snapshot);
  if (historyStack.length > HISTORY_LIMIT) historyStack.shift();
  historyIndex = historyStack.length - 1;
}

// 区切り操作の直後に呼ぶ: まず直前の入力burstを独立した1エントリとして確定させ、
// 続けてこの操作自体も独立した1エントリにする（Enterでの改行が、その前の打鍵や
// 次の打鍵と同じ取り消し単位に混ざらないようにする）。
function commitHistoryBoundary() {
  commitHistoryNow();
  markHistoryDirty();
  commitHistoryNow();
}

function applyHistorySnapshot(snapshot) {
  applyingHistorySnapshot = true;
  try {
    const blocks = snapshot.blocks;
    if (blocks.length === rows.length) {
      rows.forEach((row, index) => {
        const block = blocks[index];
        // 同数のブロックでも、並べ替えを含む履歴ではIDを復元する。これをしないと
        // 以前の見直し結果が別の数式へ飛ぶ。
        row.id = isBlockId(block.id) ? block.id : row.id;
        if (row.mf.value !== block.latex) row.mf.value = block.latex;
        setRowWorldPosition(row, block, index);
        row.lastConfirm = null;
      });
    } else {
      clearRowsForNote();
      blocks.forEach((item) => createRow(false, String(item.latex || ''), item));
    }
    // layoutModeは意図的に書き戻さない。表示モードの切替はカメラのpan/zoomと同じく
    // 「編集」ではないため、取り消しの対象から外す（段階2で申し送った不具合の修正）。
    // これを書き戻すと、新規ノート作成直後にキャンバスへ切り替えて編集を重ねた状態から
    // Ctrl+Zで切替前まで戻し切ったとき、表示モードごと行モードへ戻ってしまっていた。
    activeRowIndex = Math.max(0, Math.min(rows.length - 1, snapshot.activeIndex));
    renderLayoutMode();
    const row = activeRow();
    if (row) {
      const maxPos = row.mf.lastOffset ?? snapshot.position;
      row.mf.position = Math.max(0, Math.min(snapshot.position, maxPos));
      reconcileStack(row);
      checkDepth(row);
      claimRowFocus(row);
      renderBreadcrumb();
    }
    scheduleNoteSave();
  } finally {
    applyingHistorySnapshot = false;
  }
}

function performUndo() {
  // 未確定の入力burst（デバウンス待ち、または確定操作の直後に非同期で届く
  // 重複inputの残り）があれば、Ctrl+Zの対象として先に確定させる。中身が直前と
  // 同じならcommitHistoryNow()が何も積まないので、実質「その場でキャンセル」になる。
  commitHistoryNow();
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  applyHistorySnapshot(historyStack[historyIndex]);
}

function performRedo() {
  // 保留中の変更を先に確定させる。それが実際に新しい内容なら、進んだ先
  // （redo対象）は既に古くなっているのでここで捨てる（新しい編集は redo を無効にする）。
  commitHistoryNow();
  if (historyIndex >= historyStack.length - 1) return;
  historyIndex += 1;
  applyHistorySnapshot(historyStack[historyIndex]);
}

// ---------------------------------------------------------------------------
// OS標準IME遮断（数式ブロック用）。SHIKITYPEは物理キーcodeを専用IMEとして
// 解釈する。composition/inputを候補へ転用しないため、OS側の確定文字が数式や
// 読みに混ざる入口を閉じる。
// ---------------------------------------------------------------------------

function attachImeGuard(row) {
  const mf = row.mf;
  let preValue = null;
  let prePosition = null;
  const restoreNativeInput = () => {
    if (preValue !== null && mf.value !== preValue) {
      mf.value = preValue;
      mf.position = prePosition;
    }
  };

  mf.addEventListener('compositionstart', (e) => {
    if (isNativeTextEntry(row)) return;
    preValue = mf.value;
    prePosition = mf.position;
    e.preventDefault();
  }, true);

  mf.addEventListener('compositionupdate', (e) => {
    if (isNativeTextEntry(row)) return;
    e.preventDefault();
  }, true);

  mf.addEventListener('compositionend', (e) => {
    if (isNativeTextEntry(row)) return;
    e.preventDefault();
    restoreNativeInput();
    preValue = null;
    prePosition = null;
  }, true);

  mf.addEventListener('beforeinput', (e) => {
    if (isNativeTextEntry(row)) return;
    // 通常のinsertTextまで止めると、自前のexecuteCommand()もMathLive内部の
    // beforeinputを通ってしまう。OS IME固有のcomposition系だけを遮断する。
    if (/^(insertCompositionText|insertFromComposition)$/.test(e.inputType || '')) {
      if (preValue === null) { preValue = mf.value; prePosition = mf.position; }
      e.preventDefault();
    }
  }, true);
  mf.addEventListener('input', () => {
    if (isNativeTextEntry(row)) { scheduleNoteSave(); return; }
    if (preValue === null) return;
    queueMicrotask(() => { restoreNativeInput(); preValue = null; prePosition = null; });
  }, true);

  mf.addEventListener('paste', (e) => {
    if (!isShikitypeTransformLayer() || activeRow() !== row) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text && /^[A-Za-z\u3040-\u309f\u30a0-\u30ffー-]+$/.test(text)) appendConversionText(row, text);
    e.preventDefault();
  }, true);
}

// ---------------------------------------------------------------------------
// キー入力の完全な横取り（capture phase）
// ---------------------------------------------------------------------------

function isWithinRow(target) {
  return rows.some((r) => r.mf === target || r.mf.contains?.(target) || r.inputProxy === target);
}

function isInSettingsControl(target) {
  const sidebar = document.getElementById('sidebar');
  return !!sidebar?.open && target instanceof HTMLElement
    && sidebar.contains(target) && target.closest('button,input,select,textarea,a[href]');
}

function stopCapturedKey(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

// SHIKITYPE変換方式の全層をdocument captureの先頭で受ける。MathLive・既存
// keymapのどちらにも未確定の読みやOS IME文字を渡さない。
function routeShikitypeImeKey(event) {
  if (!isShikitypeTransformLayer() || event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = document.activeElement;
  if (isInSettingsControl(target)) return false;
  if (!isWithinRow(target)) return false;
  const row = activeRow();
  if (!row?.conversion) return false;

  // 文の内部はOS標準IMEを含む通常の文章入力。ここで止めると英字Spaceや
  // compositionが一文字も入らなくなるため、数式側の専用IMEとは完全に分ける。
  if (isNativeTextContext(row)) return false;

  if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.code)) {
    const handled = handleConversionKey(row, event);
    if (!handled && event.code === 'Tab') {
      tickKeystroke();
      cycleBaseLayer(false);
      stopCapturedKey(event);
      return true;
    }
    // 候補選択中だけ矢印／Enterを専用IMEが持つ。読みが空、または候補ナビゲーション
    // ではないときは後続の既存数式処理（矢印=キャレット、上下=行移動、Enter=改行）へ渡す。
    if (!handled) return false;
    stopCapturedKey(event);
    return true;
  }
  if (event.code === 'Backspace') {
    // 読みがある間だけrawを一打鍵戻す。空なら既存の構造化Backspaceへ渡す。
    if (!row.conversion.raw) return false;
    deleteConversionText(row);
    stopCapturedKey(event);
    return true;
  }
  // 専用IMEの正は物理英字キー。OSのかな・compositionを入力源にしない。
  // `pi` は「ぴ」途中のままなのでπ候補を出さず、`pai`で初めてπになる。
  if (/^Key[A-Z]$/.test(event.code) || event.code === 'Minus') {
    // 長押し方式の短押しも、変換層では必ず未確定の読みへ入れる。タイマーが
    // 成立したときだけ記号層のアクションを直接実行し、文字は一切流さない。
    if (inputMethod === 'hold' && /^Key[A-Z]$/.test(event.code)) {
      beginShikitypeLongPress(event, row, event.code.slice(3).toLowerCase());
      stopCapturedKey(event);
      return true;
    }
    appendConversionText(row, event.code === 'Minus' ? '-' : event.code.slice(3).toLowerCase());
    stopCapturedKey(event);
    return true;
  }
  return false;
}

document.addEventListener('keydown', (e) => {
  // showModal()直後は起点ボタンにfocusが残るブラウザがある。この場合もEscは
  // 数式パレットではなくアカウントdialogを閉じる（dialog自身までbubbleしない）。
  const accountDialog = document.getElementById('account-dialog');
  if (e.code === 'Escape' && accountDialog?.open) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    accountDialog.close();
    return;
  }

  // 設定modalは数式用のグローバルキー捕捉から完全に分離する。特にTabは
  // native dialog の通常のフォーカス循環へ渡し、設定内で層が切り替わらないようにする。
  // （背景はshowModal()がinertにするため、activeElementが一瞬起点に残っても安全。）
  const settingsDialog = document.getElementById('sidebar');
  if (settingsDialog?.open) {
    if (e.code === 'Escape') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      flashSpecial('Escape');
      toggleSidebar(false);
    }
    return;
  }

  // ノート作成／キーガイド単元の二段階dialogも同様に分離する。ここを素通りさせると
  // 下のパレット開閉Escapeが先に奪い、dialog自身のcancelハンドラへ届かないまま
  // モーダルが閉じなくなる（アカウント/設定dialogと同じ理由）。
  const newNoteDialog = document.getElementById('new-note-dialog');
  if (newNoteDialog?.open) {
    if (e.code === 'Escape') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      closeNewNoteDialog();
    }
    return;
  }
  const guideUnitDialogEl = document.getElementById('guide-unit-dialog');
  if (guideUnitDialogEl?.open) {
    if (e.code === 'Escape') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      closeGuideUnitDialog();
    }
    return;
  }

  // 見直しmodalではTab/矢印/Enterをフォームの操作へ渡す。背景の数式IMEが
  // 候補操作や改行として奪うと、問題文を入力できなくなるため完全に分離する。
  const reviewDialog = document.getElementById('review-dialog');
  if (reviewDialog?.open) {
    if (e.code === 'Escape') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      reviewDialog.close();
    }
    return;
  }

  // 変換queryにfocusがあっても、accessibleモードの画面操作キーは従来どおり
  // 優先する。専用IMEは文字・候補操作だけを所有し、F2/F4/F8/F9は奪わない。
  if (keyCaptureMode === 'accessible' && ['F2', 'F4', 'F8', 'F9'].includes(e.code)) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (e.code === 'F2') toggleSidebar();
    else if (e.code === 'F4') toggleKeyGuide();
    else applyTheme(nextThemeId(e.code === 'F9' ? 1 : -1));
    return;
  }

  if (routeShikitypeImeKey(e)) return;
  const paletteOpen = document.getElementById('palette').classList.contains('open');

  // Escape: 設定ドロワー内では閉じる操作を優先する。パレットへ奪われない。
  if (e.code === 'Escape' && document.getElementById('sidebar')?.open) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    flashSpecial('Escape');
    toggleSidebar(false);
    return;
  }

  // Escape: canvasで矩形選択済みのブロックがあれば、パレット開閉より先に選択解除を優先する。
  if (e.code === 'Escape' && selectedRows.size > 0) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    flashSpecial('Escape');
    clearSelection();
    return;
  }

  // Escape: パレットの開閉（常時捕捉）
  if (e.code === 'Escape') {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    flashSpecial('Escape');
    togglePalette();
    return;
  }

  if (paletteOpen) {
    // パレット表示中は矢印キー＋Enterで選択できる（マウス必須にしない原則）。
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    handlePaletteKey(e);
    return;
  }

  const withinRow = document.activeElement && isWithinRow(document.activeElement);

  // 取り消し・やり直し（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）。
  // 設定モーダルは上のreturnで既に外れている。文章ブロック（\text{}内）と
  // アカウントdialog等の通常input/textarea/selectは、そのフィールド本来の
  // 取り消し動作を奪わないようここでは対象外にする。それ以外（数式編集面・
  // canvasの空白面フォーカスを含む）はこのアプリの履歴で取り消す。
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
    const target = document.activeElement;
    // math-field自体もisContentEditable=trueを持つため、行の外（設定・アカウント
    // dialogの通常input/textarea/select等）にフォーカスがある場合だけ
    // 「そのフィールド本来の取り消し」を優先し、行の中はこのアプリの履歴が持つ。
    const nativeEditable = !withinRow && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable));
    const inNativeText = withinRow && isNativeTextContext(activeRow());
    if (!nativeEditable && !inNativeText) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) performRedo(); else performUndo();
      return;
    }
  }

  // 選択ブロックの一括削除（Delete / Backspace）。行にフォーカスが無い状態
  // （矩形選択でブロックを選んだ直後など）だけを対象にする。行編集中の
  // Backspace（既存の再変換・通常削除）はwithinRow側の後続処理にそのまま任せる。
  // withinRowだけで判定しないのは、矩形選択の直前まで編集していた行のMathLive内部
  // sinkが、選択後もdocument.activeElementへ残る（MathLive自身が非同期に再focusする
  // ため、blur()だけでは確実に外せない。実測で確認済み）ため。selectionFocusOverrideは
  // 「直近の操作が矩形選択の確定だった」ことだけを見るので、この場合でも正しく
  // まとめて削除へ倒す。
  if ((!withinRow || selectionFocusOverride) && layoutMode === 'canvas' && selectedRows.size > 0 && (e.code === 'Delete' || e.code === 'Backspace')) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    deleteSelectedRows();
    return;
  }

  // ブロックのコピー・貼り付け（Ctrl+C / Ctrl+V）。
  // 数式編集面のCtrl+Cはこれまで割り当てが無く、末尾の一括preventDefault()に
  // 握りつぶされて何も起きていなかった（\text{}内の文章だけがブラウザ標準の
  // 文字コピーを持つ）。よってブロック単位のコピーは既存挙動の上書きではなく
  // 新規追加であり、\text{}内と外部input/textarea/select（nativeEditable）だけを
  // 対象外にすれば安全に割り当てられる。
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
    const target = document.activeElement;
    const nativeEditable = !withinRow && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable));
    const inNativeText = withinRow && isNativeTextContext(activeRow());
    if (!nativeEditable && !inNativeText) {
      if (e.code === 'KeyC') {
        if (copyBlocksToClipboard()) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
      } else if (blockClipboard) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        pasteBlockClipboard();
        return;
      }
      // Ctrl+VでblockClipboardが空のときはここでは何もしない。ブロックコピーを
      // 一度も使っていない利用者には、下の既存Ctrl+V（Unicode文字貼り付け）を
      // そのまま通し、従来の挙動を保つ。
    }
  }

  // キー操作モードが accessible のときだけ、数式欄フォーカス中でも画面操作キーを奪う。
  // F2=設定 / F4=キーガイド / F8・F9=テーマ切替。original モードでは従来どおり何もしない。
  // 設定内のボタンでは Enter/Space を普通の押下として扱う。
  // 全キー横取りがこれを奪うと、設定操作そのものがキーボードから不能になる。
  if (isInSettingsControl(document.activeElement)) return;

  if (!withinRow) return; // 行にフォーカスが無いときはページの既定動作を邪魔しない

  // 文の中は通常の文章入力を通す。ただしEnterは文を明示的に閉じるキーとして
  // ここで所有し、段落や次の数式blockを増やさない。
  if (isShikitypeTransformLayer() && isNativeTextContext(activeRow())) {
    if (e.code !== 'Enter') return;
    stopCapturedKey(e);
    const row = activeRow();
    closeOneLevel(row);
    renderBreadcrumb();
    focusProxyAfterNativeClose(row);
    return;
  }

  // Ctrl+V: クリップボードのUnicode数式らしき文字列をLaTeXへ変換して流し込む
  if (e.ctrlKey && e.code === 'KeyV') {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    handlePaste();
    return;
  }

  // すべてのキーを捕捉する（未割り当てキーも含めて既定動作を確実に止める）
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  flashKey(e.code);
  if (e.code === 'Space' || e.code === 'Enter') flashSpecial(e.code);

  const row = activeRow();
  if (!row) return;
  const effectiveShift = e.shiftKey || virtualShift;

  if (beginPhysicalLongPress(e, row, effectiveShift)) return;

  if (e.code === 'Enter') {
    tickKeystroke();
    newRowAfterActive();
    clearVirtualShift();
    return;
  }

  if (e.code === 'Space') {
    tickKeystroke();
    if (effectiveShift) reopenOneLevel(row);
    else closeOneLevel(row);
    renderBreadcrumb();
    clearVirtualShift();
    return;
  }

  if (e.code === 'Tab') {
    tickKeystroke();
    cycleBaseLayer(e.shiftKey);
    flashSpecial('Tab');
    return;
  }

  if (e.code === 'Backspace') {
    tickKeystroke();
    if (tryReconvertLastConfirm(row)) { renderBreadcrumb(); return; }
    backspace(row);
    renderBreadcrumb();
    return;
  }

  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    tickKeystroke();
    moveCaret(row, e.code === 'ArrowLeft' ? -1 : 1);
    renderBreadcrumb();
    return;
  }

  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    tickKeystroke();
    moveRow(e.code === 'ArrowUp' ? -1 : 1);
    renderBreadcrumb();
    return;
  }

  const action = resolveAction(e.code, activeInputLayer(), effectiveShift);
  if (!action) return; // 未割り当てキー: 既定動作は既に止めてあるので何もしない

  tickKeystroke();
  dispatchAction(row, action);
  renderBreadcrumb();
  clearVirtualShift();
  consumeTemporaryLayer();
}, true);

// ---------------------------------------------------------------------------
// キー操作モード（accessible / original）と画面操作ショートカット
// accessible: 数式欄フォーカス中でも F2=設定 F4=キーガイド F8/F9=テーマ切替が効く。
// original: 従来どおり全キーを数式欄が奪う。サイドバーから選べる。
// ---------------------------------------------------------------------------

function setKeyCaptureMode(mode, persist = true) {
  if (!KEY_CAPTURE_MODES[mode]) return;
  keyCaptureMode = mode;
  if (persist) {
    try { localStorage.setItem(KEY_CAPTURE_KEY, mode); }
    catch (err) { console.warn('[neo-math] key capture mode save failed', err); }
  }
  document.body.dataset.keyCapture = mode;
  document.querySelectorAll('.capture-choice').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.captureMode === mode));
  });
}

function nextThemeId(dir) {
  const ids = Object.keys(THEMES);
  const current = document.body.dataset.theme;
  const i = ids.indexOf(current);
  return ids[(i + dir + ids.length) % ids.length];
}

function toggleKeyGuide() {
  const guide = document.getElementById('key-guide');
  // CSSのテーマ切替や復元処理が先に走っても、内部フラグではなく現在の画面状態を
  // 基準に反転する。F4と画面ボタンで開閉状態が食い違わないようにする。
  guideExpanded = guide.classList.contains('collapsed');
  guide.classList.toggle('collapsed', !guideExpanded);
  document.getElementById('key-guide-toggle').textContent = guideExpanded ? '畳む' : '開く';
}

document.getElementById('key-guide-toggle')?.addEventListener('click', toggleKeyGuide);

function dispatchAction(row, action) {
  switch (action.type) {
    case 'open':
      if (action.kind === 'paren') openSingleSlot(row, 'paren', '\\left(#0\\right)');
      else if (action.kind === 'sqrt') openSingleSlot(row, 'sqrt', '\\sqrt{#0}');
      else if (action.kind === 'abs') openSingleSlot(row, 'abs', '\\left|#0\\right|');
      else if (action.kind === 'sup') openSingleSlot(row, 'sup');
      else if (action.kind === 'sub') openSingleSlot(row, 'sub');
      break;
    case 'nfrac': openNfrac(row); break;
    case 'afrac': openAfrac(row); break;
    case 'lim': openSingleSlot(row, 'lim', '\\lim_{#0}'); break;
    case 'text': openText(row); break;
    case 'sum': openSum(row); break;
    case 'op': insertOperator(row, action.symbol); break;
    case 'literal': insertLiteral(row, action.latex); break;
    case 'term-literal': insertTermLiteral(row, action.latex); break;
    case 'func': insertFunc(row, action.name); break;
    case 'digit': insertDigit(row, action.value); break;
    case 'variable': insertVariable(row, action.letter); break;
    case 'greek': insertVariable(row, action.latex); break;
    default: console.warn('[neo-math] unknown action', action);
  }
  scheduleConversionCaret(row);
}

function handlePaste() {
  navigator.clipboard.readText().then((text) => {
    if (!text) return;
    const row = activeRow();
    const converted = convertUnicodeToLatex(text);
    row.mf.executeCommand(['insert', converted, { insertionMode: 'replaceSelection', format: 'latex' }]);
    clearRun(row); // 貼り付けは構造化しない（3F7B項目5どおり）ので項履歴は一旦リセットする
  }).catch((err) => {
    console.warn('[neo-math] clipboard read failed', err);
  });
}

// ---------------------------------------------------------------------------
// キーガイド（単元でフィルタ表示。割り当ては動かさない）
// ---------------------------------------------------------------------------

const UNIT_KEY = 'neo-math.unit.v1';
const UNIT_IDS = new Set([ALL_UNITS_ID, ...UNITS.map((u) => u.id)]);
// noteUnitScopeはノートに保存する学習範囲、currentUnitはキーガイドとパレットだけの
// 一時プリセット。全単元ノートでは両者を分けることで、個別の手掛かりを見ても
// ノート自体の範囲を勝手に狭めない。
let noteUnitScope = ALL_UNITS_ID;
let currentUnit = ALL_UNITS_ID;
try {
  const savedUnit = localStorage.getItem(UNIT_KEY);
  if (savedUnit && UNIT_IDS.has(savedUnit)) currentUnit = savedUnit;
} catch { /* 保存不可でも既定単元で続行する */ }
let currentSubject = currentUnit === ALL_UNITS_ID ? ALL_UNITS_ID : (UNITS.find((u) => u.id === currentUnit)?.subject ?? 's3');

function updateCourseLabel() {
  // ノートの学習範囲は上バーに固定で出す。全単元ノート内でキーガイドだけを
  // 個別単元へ寄せても、ノート自体が狭まったように見せない。
  const scopeUnit = noteUnitScope === ALL_UNITS_ID ? null : UNITS.find((u) => u.id === noteUnitScope);
  const courseLabel = document.getElementById('course-label');
  if (courseLabel) {
    courseLabel.innerHTML = scopeUnit
      ? `<span>${scopeUnit.subjectLabel}</span>${scopeUnit.label}`
      : '<span>高校数学</span>全単元';
  }
  if (currentUnit === ALL_UNITS_ID) {
    const guideTitle = document.getElementById('key-guide-title');
    if (guideTitle) guideTitle.textContent = '全単元 キーガイド';
    document.body.dataset.noteScope = noteUnitScope;
    return;
  }
  const unit = UNITS.find((u) => u.id === currentUnit);
  if (!unit) return;
  const guideTitle = document.getElementById('key-guide-title');
  if (guideTitle) guideTitle.textContent = `${unit.subjectLabel}・${unit.label} キーガイド`;
  document.body.dataset.noteScope = noteUnitScope;
}

function setCurrentUnit(unitId, persist = true) {
  if (!UNIT_IDS.has(unitId)) return;
  currentUnit = unitId;
  const unit = UNITS.find((u) => u.id === unitId);
  currentSubject = unit?.subject ?? ALL_UNITS_ID;
  if (persist) {
    try { localStorage.setItem(UNIT_KEY, currentUnit); }
    catch (err) { console.warn('[neo-math] unit save failed', err); }
  }
  updateCourseLabel();
  renderKeyGuide();
  renderPalette();
}

function setNoteUnitScope(unitId) {
  if (!UNIT_IDS.has(unitId)) return;
  noteUnitScope = unitId;
  setCurrentUnit(unitId);
  scheduleNoteSave();
}

function setCurrentSubject(subjectId) {
  if (subjectId === ALL_UNITS_ID) { setCurrentUnit(ALL_UNITS_ID); return; }
  const subject = SUBJECTS.find((s) => s.id === subjectId);
  if (!subject) return;
  // 科目を変えたら、その科目の先頭単元を選ぶ（未選択状態を作らない）。
  setCurrentUnit(subject.units[0].id);
}

let guideExpanded = true;

// Tabで基底レイヤーを循環し、Shiftは英字/ギリシャ文字だけを押下中に大文字化する。
let baseLayer = 'symbol';
let virtualShift = false;
let physicalShift = false;

function activeInputLayer() {
  if (inputSystem === 'conversion') return temporaryLayer ?? baseLayer;
  if (inputMethod === 'hold') return holdShortLayer();
  return temporaryLayer ?? baseLayer;
}

function nextLayer(layer, method = inputMethod) {
  if (method === 'hold') return layer === 'latin' ? 'greek' : 'latin';
  return LAYERS[(LAYERS.indexOf(layer) + 1) % LAYERS.length];
}

function isUppercaseGuide() {
  return activeInputLayer() !== 'symbol' && (physicalShift || virtualShift);
}

function layerDisplayName() {
  const layer = activeInputLayer();
  const temporary = temporaryLayer ? '・一時' : '';
  if (inputSystem === 'conversion' && layer === 'symbol') return `変換・読み${temporary}`;
  if (layer === 'symbol') return `記号${temporary}`;
  return `${LAYER_NAMES[layer]}・${isUppercaseGuide() ? '大文字' : '小文字'}${temporary}`;
}

function conversionKeyText(code) {
  return /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : '';
}

// 変換方式の長押しは、各層の短押しとは別に既存の記号層を直接呼ぶ。
// 従来方式では従来どおり「方式ごとの基底層」設定を尊重する。
function longPressLayer() {
  return inputSystem === 'conversion' ? 'symbol' : holdLongLayer();
}

function keyCap(code, layer, interactive = false, uppercase = false, { selectableOnly = false } = {}) {
  // 変換方式の三層はいずれも「物理英字を読みbufferへ入れる」面。旧来方式だけが
  // 層ごとの直接記号入力なので、ガイドも実挙動と同じraw英字を示す。
  const shikitypeKey = inputSystem === 'conversion' && !selectableOnly;
  const label = shikitypeKey ? conversionKeyText(code) : labelFor(code, layer, uppercase);
  const holdSymbolLabel = inputMethod === 'hold' && /^Key[A-Z]$/.test(code)
    ? labelFor(code, longPressLayer(), false)
    : null;
  const cap = document.createElement(interactive ? 'button' : 'div');
  cap.className = 'key-cap';
  cap.dataset.code = code;
  if (interactive) {
    cap.type = 'button';
    cap.setAttribute('aria-label', selectableOnly
      ? holdSymbolLabel
        ? `${keyDisplayName(code)}キー: 短押し ${label ?? '未割り当て'}、長押し ${holdSymbolLabel}（設定で選択）`
        : `${keyDisplayName(code)}キー: ${label ?? '未割り当て'}（設定で選択）`
      : holdSymbolLabel
        ? `${keyDisplayName(code)}キー: 短押し ${label ?? '未割り当て'}、長押し ${holdSymbolLabel}`
        : `${keyDisplayName(code)}キー: ${label ?? '未割り当て'}`);
    if (!selectableOnly) {
      // 押した瞬間に数式欄からフォーカスが外れると、次の物理打鍵が1回死ぬ。
      cap.addEventListener('pointerdown', (e) => beginPointerLongPress(e, cap, code));
      cap.addEventListener('pointerup', (e) => finishPointerLongPress(e, cap, code));
      cap.addEventListener('pointercancel', () => cancelPointerLongPress(cap));
      cap.addEventListener('mousedown', (e) => e.preventDefault());
      cap.addEventListener('click', () => {
        if (cap._suppressNeoClick) { cap._suppressNeoClick = false; return; }
        handleVirtualKey(code);
      });
    }
  }
  if (label === null && holdSymbolLabel === null) {
    cap.classList.add('unassigned');
    if (interactive && !selectableOnly) {
      cap.disabled = true;
      cap.setAttribute('aria-disabled', 'true');
    }
  } else {
    // 単元外のキーも「消さずに」薄くする。キーを間引くと並びが実際のキーボードと
    // ずれてしまい、物理配列を写すというキーガイドの目的そのものが壊れる。
    if (layer === 'symbol' && !isKeyInUnit(code, currentUnit)) {
      cap.classList.add('out-of-unit');
    }
    if (getOverride(code, layer)) cap.classList.add('customized');
  }
  const symbol = document.createElement('span');
  symbol.className = 'key-symbol';
  symbol.textContent = label ?? '';
  if (label && label.length >= 4) symbol.classList.add('long');
  const origin = document.createElement('span');
  origin.className = 'key-origin';
  origin.textContent = keyDisplayName(code);
  cap.append(symbol, origin);
  if (holdSymbolLabel !== null) {
    const holdAlt = document.createElement('span');
    holdAlt.className = 'key-hold-symbol';
    holdAlt.textContent = holdSymbolLabel;
    cap.appendChild(holdAlt);
  }
  return cap;
}

function renderKeyGuide() {
  const el = document.getElementById('key-guide-board');
  if (!el) return;
  el.innerHTML = '';
  // 物理キーボードの段（QWERTY見た目）どおりに3行で描く。
  // 視線が実際の指の位置と一致するので、チップの中身を1つずつ読んで探す必要がなくなる。
  physicalRows.forEach((rowCodes, i) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'key-row';
    // 実物のキーボードと同じ段差。段が揃っていると、どの段かを一瞬で見誤る。
    for (const code of rowCodes) rowEl.appendChild(keyCap(code, activeInputLayer(), true, isUppercaseGuide()));
    el.appendChild(rowEl);
  });
  document.getElementById('key-guide-layer').textContent = layerDisplayName();
  const tabHint = document.querySelector('[data-special="Tab"] small');
  if (tabHint) {
    if (inputSystem === 'conversion') {
      tabHint.textContent = `次: ${LAYER_NAMES[nextLayer(activeInputLayer())] === '記号' ? '変換' : LAYER_NAMES[nextLayer(activeInputLayer())]}`;
    } else {
    // 長押し方式は Tab が常に baseLayer（英字⇔ギリシャ）を送るので、その値で見せる
    // （短押し/長押しの入れ替え設定に関わらず、Tabの挙動自体は一定）。
    const next = LAYER_NAMES[inputMethod === 'hold' ? nextLayer(baseLayer, 'hold') : nextLayer(activeInputLayer())];
    tabHint.textContent = inputMethod === 'hybrid' ? `一時: ${next}` : `次: ${next}`;
    }
  }
  const lock = document.getElementById('layer-lock');
  if (lock) {
    lock.setAttribute('aria-pressed', String(temporaryLayer === null));
    lock.querySelector('small').textContent = `${LAYER_NAMES[baseLayer]}を固定`;
  }
  renderResidentSymbols();
  updateModifierButtons();
}

function syncGuideLayer() {
  renderKeyGuide();
}

function updateModifierButtons() {
  document.querySelectorAll('[data-modifier]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(virtualShift));
    btn.classList.toggle('is-physical', physicalShift);
  });
}

// 修飾キーの押し下げ／離しでガイドの層を追従させる。
// 張り先は window の capture 段でなければならない。document へ後から張った
// リスナーは capture / bubble とも一度も発火しないことを実測で確認している
// （keydown 2回に対し document:0 / window(capture):2）。伝播が document へ
// 届く前に止められているため、ここだけは window を使う。
window.addEventListener('keydown', (e) => {
  const next = e.shiftKey;
  if (next !== physicalShift) { physicalShift = next; syncGuideLayer(); }
}, { capture: true, passive: true });

window.addEventListener('keyup', (e) => {
  const next = e.shiftKey;
  if (next !== physicalShift) { physicalShift = next; syncGuideLayer(); }
  finishPhysicalLongPress(e);
}, { capture: true });

window.addEventListener('blur', () => {
  physicalShift = false;
  cancelPhysicalLongPress();
  syncGuideLayer();
});

function isLongPressCandidate(code) {
  return inputMethod === 'hold' && /^Key[A-Z]$/.test(code)
    && !!resolveAction(code, longPressLayer(), false);
}

function markKeyHoldState(code, state) {
  const cap = document.querySelector(`#key-guide-board .key-cap[data-code="${code}"]`);
  if (!cap) return;
  cap.classList.toggle('is-holding', state === 'holding');
  cap.classList.toggle('is-long-fired', state === 'fired');
}

function commitInputAction(row, action) {
  if (!row || !action) return false;
  tickKeystroke();
  dispatchAction(row, action);
  renderBreadcrumb();
  clearVirtualShift();
  consumeTemporaryLayer();
  return true;
}

function beginPhysicalLongPress(e, row, uppercase) {
  if (!isLongPressCandidate(e.code) || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.repeat || physicalLongPress?.code === e.code) return true;
  cancelPhysicalLongPress();
  const state = {
    code: e.code,
    row,
    layer: activeInputLayer(),
    uppercase,
    fired: false,
    timer: null,
  };
  physicalLongPress = state;
  markKeyHoldState(e.code, 'holding');
  state.timer = setTimeout(() => {
    if (physicalLongPress !== state) return;
    state.fired = commitInputAction(state.row, resolveAction(state.code, longPressLayer(), state.uppercase));
    markKeyHoldState(state.code, 'fired');
  }, LONG_PRESS_MS);
  return true;
}

function beginShikitypeLongPress(e, row, text) {
  if (e.repeat || physicalLongPress?.code === e.code) return true;
  cancelPhysicalLongPress();
  const state = {
    code: e.code,
    row,
    layer: 'symbol',
    uppercase: false,
    conversionText: text,
    fired: false,
    timer: null,
  };
  physicalLongPress = state;
  markKeyHoldState(e.code, 'holding');
  state.timer = setTimeout(() => {
    if (physicalLongPress !== state) return;
    const action = resolveAction(state.code, 'symbol', false);
    state.fired = action ? commitInputAction(state.row, action) : false;
    markKeyHoldState(state.code, 'fired');
  }, LONG_PRESS_MS);
  return true;
}

function finishPhysicalLongPress(e) {
  const state = physicalLongPress;
  if (!state || e.code !== state.code) return false;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  clearTimeout(state.timer);
  physicalLongPress = null;
  if (state.conversionText) {
    if (!state.fired) appendConversionText(state.row, state.conversionText);
  } else if (!state.fired) {
    commitInputAction(state.row, resolveAction(state.code, state.layer, state.uppercase));
  }
  markKeyHoldState(state.code, 'idle');
  flashKey(state.code);
  if (isShikitypeTransformLayer()) openConversion(activeRow(), true);
  else focusActiveRow();
  return true;
}

function cancelPhysicalLongPress() {
  if (!physicalLongPress) return;
  clearTimeout(physicalLongPress.timer);
  markKeyHoldState(physicalLongPress.code, 'idle');
  physicalLongPress = null;
}

function beginPointerLongPress(e, cap, code) {
  e.preventDefault();
  if (!isLongPressCandidate(code)) return;
  cancelPointerLongPress(cap);
  const state = { fired: false, timer: null };
  cap._neoLongPress = state;
  cap.classList.add('is-holding');
  state.timer = setTimeout(() => {
    if (cap._neoLongPress !== state) return;
    state.fired = handleLongPressSymbol(code);
    cap.classList.remove('is-holding');
    cap.classList.add('is-long-fired');
  }, LONG_PRESS_MS);
}

function finishPointerLongPress(e, cap, code) {
  if (!cap._neoLongPress) return;
  e.preventDefault();
  const state = cap._neoLongPress;
  clearTimeout(state.timer);
  cap._neoLongPress = null;
  cap.classList.remove('is-holding', 'is-long-fired');
  if (!state.fired) handleVirtualKey(code);
  cap._suppressNeoClick = true;
}

function cancelPointerLongPress(cap) {
  if (!cap._neoLongPress) return;
  clearTimeout(cap._neoLongPress.timer);
  cap._neoLongPress = null;
  cap.classList.remove('is-holding', 'is-long-fired');
}

function handleLongPressSymbol(code) {
  const row = activeRow();
  const committed = commitInputAction(row, resolveAction(code, longPressLayer(), false));
  if (committed) flashKey(code);
  if (isShikitypeTransformLayer()) openConversion(activeRow(), true);
  else focusActiveRow();
  return committed;
}

// 押したキーを一瞬光らせる。今どこを叩いたかが見えると、打ち間違いに気づくのが早い。
export function flashKey(code) {
  const cap = document.querySelector(`#key-guide-board .key-cap[data-code="${code}"]`);
  if (!cap) return;
  cap.classList.add('pressed', 'is-pressed');
  clearTimeout(cap._neoFlashTimer);
  cap._neoFlashTimer = setTimeout(() => cap.classList.remove('pressed', 'is-pressed'), 150);
}

function latchVirtualShift() {
  virtualShift = !virtualShift;
  syncGuideLayer();
  focusActiveRow();
}

function clearVirtualShift() {
  if (!virtualShift) return;
  virtualShift = false;
  syncGuideLayer();
}

function cycleBaseLayer(lockLayer = false) {
  let next;
  if (inputSystem === 'conversion') {
    // 変換方式では長押し設定中でも3層を必ず通れる。変換層へ戻る経路を失うと
    // 専用IMEの入口が消えるため、従来の英字⇔ギリシャだけの循環は使わない。
    const sourceLayer = activeInputLayer();
    const sourceMethod = inputMethod;
    next = nextLayer(sourceLayer);
    if (sourceMethod === 'hybrid' && !lockLayer) {
      temporaryLayer = next === baseLayer ? null : next;
      temporaryTransition = temporaryLayer ? { returnLayer: baseLayer, sourceLayer, sourceMethod } : null;
    } else {
      baseLayer = next;
      temporaryLayer = null;
      temporaryTransition = null;
    }
  } else if (inputMethod === 'hold') {
    // 長押し方式は短押し/長押しの入れ替え設定に関わらず、baseLayerが常に
    // 英字⇔ギリシャの状態を保持する（symbolは長押し側にのみ現れるため）。
    next = nextLayer(baseLayer, 'hold');
    baseLayer = next;
    temporaryLayer = null;
    temporaryTransition = null;
  } else if (inputMethod === 'hybrid' && !lockLayer) {
    next = nextLayer(activeInputLayer());
    temporaryLayer = next === baseLayer ? null : next;
    temporaryTransition = temporaryLayer ? { returnLayer: baseLayer, sourceLayer: baseLayer, sourceMethod: inputMethod } : null;
  } else {
    next = nextLayer(activeInputLayer());
    baseLayer = next;
    temporaryLayer = null;
    temporaryTransition = null;
  }
  if (inputSystem === 'conversion') inputMethod = inputMethodForLayer(next ?? activeInputLayer());
  virtualShift = false;
  updateInputMethodUI();
  renderKeyGuide();
  if (isShikitypeTransformLayer()) openConversion(activeRow(), true);
  else {
    for (const row of rows) if (row.conversion) row.conversion.shell.hidden = true;
    conversionOpen = false;
    focusActiveRow();
  }
}

function lockCurrentLayer() {
  if (inputMethod !== 'hybrid' && !temporaryTransition) return;
  baseLayer = temporaryLayer ?? baseLayer;
  temporaryLayer = null;
  temporaryTransition = null;
  inputMethod = inputMethodForLayer(baseLayer);
  updateInputMethodUI();
  renderKeyGuide();
  if (isShikitypeTransformLayer()) openConversion(activeRow(), true);
  else focusActiveRow();
}

function consumeTemporaryLayer() {
  if (!temporaryTransition || temporaryLayer === null) return;
  baseLayer = temporaryTransition.returnLayer;
  temporaryLayer = null;
  temporaryTransition = null;
  inputMethod = inputMethodForLayer(baseLayer);
  updateInputMethodUI();
  renderKeyGuide();
  if (isShikitypeTransformLayer()) openConversion(activeRow(), true);
}

function handleVirtualKey(code) {
  const row = activeRow();
  if (!row) return;
  if (isShikitypeTransformLayer()) {
    const text = conversionKeyText(code);
    if (text) appendConversionText(row, text);
    flashKey(code);
    openConversion(row, true);
    return;
  }
  const action = resolveAction(code, activeInputLayer(), isUppercaseGuide());
  focusActiveRow();
  if (action) {
    tickKeystroke();
    dispatchAction(row, action);
    renderBreadcrumb();
    clearVirtualShift();
    consumeTemporaryLayer();
  }
  // 画面Shiftはタッチ操作向けに次の1キーだけ有効。物理Shiftは押している間だけ有効。
  flashKey(code);
  focusActiveRow();
}

function flashSpecial(code) {
  const key = document.querySelector(`[data-special="${code}"]`);
  if (!key) return;
  key.classList.add('is-pressed');
  clearTimeout(key._neoFlashTimer);
  key._neoFlashTimer = setTimeout(() => key.classList.remove('is-pressed'), 150);
}

function handleVirtualSpecial(code, invokedRow = activeRow()) {
  // 画面キーは pointerdown と click の間に、以前の focus rAF が別の行へ
  // フォーカスを戻すことがある。押下時の行を使えば、文の中で押した Enter が
  // その一瞬の activeRow 差し替えで「数式の Enter」へ化けない。
  // 文の中にいる間は、画面キーがpointerdown時に拾った古いactive rowよりも
  // 文を開いた行を優先する。MathLive→proxyのfocus復帰rAFとクリックが重なっても
  // 文内Enterを「新しい行」に化けさせない。
  const nativeRow = rows.includes(nativeTextRow) && isNativeTextEntry(nativeTextRow) ? nativeTextRow : null;
  const row = nativeRow ?? (rows.includes(invokedRow) ? invokedRow : activeRow());
  if (!row) return;
  // 押下対象を入力先として同期してからText/Enterを処理する。focus rAFが直前に
  // 他行へ戻していても、画面キーの操作先だけは切り替えない。
  activeRowIndex = rows.indexOf(row);
  if (code === 'Text') {
    if (isNativeTextEntry(row)) {
      // 文キーは開くだけでなく、同じ文を閉じる明示操作でもある。閉じた時点で
      // 標準IMEの入力先を外し、以後の物理キーは専用IMEへ戻す。
      closeOneLevel(row);
      renderBreadcrumb();
      flashSpecial(code);
      focusProxyAfterNativeClose(row);
      return;
    }
    // 「文」は読み候補ではなく構造を開く明示操作。変換方式中でもOS IMEへ
    // フォールバックせず、\text{}の中へカーソルを置く。
    clearConversionReading(row.conversion);
    tickKeystroke();
    openText(row);
    renderBreadcrumb();
    flashSpecial(code);
    focusActiveRow();
    return;
  }
  // 文の中の画面Enter/Tab/Escは変換IMEへ渡さない。native text編集を
  // 壊さず、少なくとも候補確定や次行作成を起こさない。
  // pointerdown時の行に加え、直前に開いた文の行も見る。click前に走る古い
  // focus rAFがactiveRowを差し替えても、文用の画面Enterは改行へ化けない。
  const openTextRow = nativeRow;
  if (isNativeTextEntry(row) || openTextRow) {
    if (code === 'Enter') {
      closeOneLevel(row);
      renderBreadcrumb();
      focusProxyAfterNativeClose(row);
    }
    flashSpecial(code);
    return;
  }
  if (isShikitypeTransformLayer()) {
    if (code === 'Tab') {
      if (!handleConversionKey(row, { code, isComposing: false, keyCode: 0 })) cycleBaseLayer(false);
    }
    else if (code === 'Enter' || code === 'Escape') {
      const handled = handleConversionKey(row, { code, isComposing: false, keyCode: 0 });
      // rawが空のEnterは従来どおり次行。rawが残るEnterはhandle側が所有し、
      // 候補なしでも意図せず改行しない。
      if (code === 'Enter' && !handled) { tickKeystroke(); newRowAfterActive(); }
    }
    else if (code === 'Space') appendConversionText(row, ' ');
    flashSpecial(code);
    if (isShikitypeTransformLayer()) openConversion(row, true);
    return;
  }
  focusActiveRow();
  if (code === 'Tab') {
    tickKeystroke();
    cycleBaseLayer(false);
  } else if (code === 'Space') {
    tickKeystroke();
    if (physicalShift || virtualShift) reopenOneLevel(row);
    else closeOneLevel(row);
    renderBreadcrumb();
  } else if (code === 'Enter') {
    tickKeystroke();
    newRowAfterActive();
  } else if (code === 'Escape') {
    tickKeystroke();
    togglePalette(true);
  }
  if (code !== 'Tab') clearVirtualShift();
  flashSpecial(code);
  focusActiveRow();
}

document.querySelectorAll('[data-modifier]').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => e.preventDefault());
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => latchVirtualShift());
});

document.querySelectorAll('[data-special]').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn._neoInvokedRow = activeRow();
  });
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    const invokedRow = btn._neoInvokedRow;
    btn._neoInvokedRow = null;
    handleVirtualSpecial(btn.dataset.special, invokedRow);
  });
});

document.getElementById('layer-lock')?.addEventListener('pointerdown', (e) => e.preventDefault());
document.getElementById('layer-lock')?.addEventListener('click', lockCurrentLayer);

// ---------------------------------------------------------------------------
// パレット（Esc）
// ---------------------------------------------------------------------------

// 3つ目の要素は単元タグ。'common' はどの単元でも先頭へは出さない（低頻度記号の
// 逃げ道という元の役割のまま）。配列は「その単元でよく使う記号」として先頭グループへ
// 昇格させる対象。単元を切り替えても、この一覧自体（＝打てる記号）は減らない。
const PALETTE_ITEMS = [
  ['α', '\\alpha ', 'common'], ['β', '\\beta ', 'common'], ['γ', '\\gamma ', 'common'], ['δ', '\\delta ', 'common'],
  ['θ', '\\theta ', 'common'], ['λ', '\\lambda ', 'common'], ['μ', '\\mu ', 'common'], ['σ', '\\sigma ', 'common'],
  ['φ', '\\phi ', 'common'], ['ψ', '\\psi ', 'common'], ['ω', '\\omega ', 'common'],
  ['Γ', '\\Gamma ', 'common'], ['Δ', '\\Delta ', 'common'], ['Θ', '\\Theta ', 'common'], ['Λ', '\\Lambda ', 'common'],
  ['Φ', '\\Phi ', 'common'], ['Ψ', '\\Psi ', 'common'], ['Ω', '\\Omega ', 'common'],
  ['ln', '\\ln ', ['s2-shisutaisu']], ['÷', '\\div ', 'common'], ['±', '\\pm ', 'common'],
  ['≒', '\\approx ', 'common'], ['≡', '\\equiv ', ['sa-seisuu']],
  ['∈', '\\in ', ['s1-shugo']], ['∉', '\\notin ', ['s1-shugo']], ['⊂', '\\subset ', ['s1-shugo']], ['⊃', '\\supset ', ['s1-shugo']],
  ['∪', '\\cup ', ['s1-shugo']], ['∩', '\\cap ', ['s1-shugo']], ['∅', '\\emptyset ', ['s1-shugo']],
  ['∀', '\\forall ', ['s1-shugo', 's2-shomei']], ['∃', '\\exists ', ['s1-shugo', 's2-shomei']],
  ['⇒', '\\Rightarrow ', ['s1-shugo', 's2-shomei']], ['⇔', '\\Leftrightarrow ', ['s1-shugo', 's2-shomei']],
  ['∧', '\\wedge ', ['s1-shugo']], ['∨', '\\vee ', ['s1-shugo']], ['¬', '\\neg ', ['s1-shugo']],
  ['∠', '\\angle ', ['s1-keiryo', 'sa-zukei']], ['△', '\\triangle ', ['s1-keiryo', 'sa-zukei']],
  ['⊥', '\\perp ', ['s1-keiryo', 'sa-zukei', 'sc-vector']], ['∥', '\\parallel ', ['s1-keiryo', 'sa-zukei', 'sc-vector']],
  ['°', '^\\circ ', ['s1-keiryo']], ['≅', '\\cong ', ['sa-zukei']], ['∽', '\\backsim ', ['sa-zukei']],
  // 統計的な推測（平均・分散・標準偏差・組合せ・順列・二項係数）
  ['x̄', '\\bar{x}', ['sb-suisoku']], ['s²', 's^2', ['sb-suisoku']],
  ['nCr', '{}_{n}\\mathrm{C}_{r}', ['sa-kakuritsu', 'sb-suisoku']],
  ['nPr', '{}_{n}\\mathrm{P}_{r}', ['sa-kakuritsu']],
  ['(n k)', '\\binom{n}{k}', ['sa-kakuritsu']],
  // ベクトル（矢印付き・内積・ノルム）
  ['a⃗', '\\vec{a}', ['sc-vector']], ['|a⃗|', '\\left|\\vec{a}\\right|', ['sc-vector']],
  ['a⃗·b⃗', '\\vec{a}\\cdot\\vec{b}', ['sc-vector']],
  // 複素数平面（共役・偏角・絶対値）
  ['z̄', '\\bar{z}', ['sc-kyokusen']], ['arg', '\\arg ', ['sc-kyokusen']], ['|z|', '\\left|z\\right|', ['sc-kyokusen']],
  // 整数（合同式・mod・約数関係）
  ['a∣b', 'a\\mid b', ['sa-seisuu']], ['(mod n)', '\\pmod{n}', ['sa-seisuu']],
  // 数列（漸化式・階差）
  ['a_n', 'a_n', ['sb-suuretsu']], ['a_{n+1}', 'a_{n+1}', ['sb-suuretsu']], ['Δa_n', '\\Delta a_n', ['sb-suuretsu']],
  // 三角比・指数対数
  ['log_a b', '\\log_a b', ['s2-shisutaisu']],
];

const PALETTE_COLS = 8; // #palette-grid の grid-template-columns と一致させる
let paletteIndex = 0;
let paletteOrder = PALETTE_ITEMS; // renderPalette() が単元に応じて並べ直した表示順（実データはPALETTE_ITEMSのまま減らない）

/** currentUnit でよく使う記号を先頭へ、それ以外は元の並びのまま後ろへ（記号は1件も減らない）。 */
function orderPaletteForUnit(unit) {
  const front = [];
  const rest = [];
  for (const item of PALETTE_ITEMS) {
    const tags = item[2];
    if (Array.isArray(tags) && tags.includes(unit)) front.push(item);
    else rest.push(item);
  }
  return [...front, ...rest];
}

function renderPalette() {
  const el = document.getElementById('palette-grid');
  if (!el) return;
  paletteOrder = orderPaletteForUnit(currentUnit);
  const featuredCount = paletteOrder.findIndex((item) => !Array.isArray(item[2]) || !item[2].includes(currentUnit));
  el.innerHTML = '';
  paletteOrder.forEach(([label], index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'palette-btn';
    if (featuredCount > 0 && index < featuredCount) btn.classList.add('featured');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      paletteIndex = index;
      insertPaletteItem(index);
      togglePalette(false);
    });
    el.appendChild(btn);
  });
}

function insertPaletteItem(index) {
  const item = paletteOrder[index];
  if (!item) return;
  const [, latex] = item;
  const row = activeRow();
  if (row) {
    row.mf.executeCommand(['insert', latex, { insertionMode: 'insertAfter', format: 'latex' }]);
    clearRun(row);
    // パレットのボタンをクリックした後は、MathLive のホスト要素だけへ focus() しても
    // 実際のキーボード受け口（shadow DOM 内）まで戻らないことがある。次の物理キーを
    // 落とさないよう、他の画面操作と同じ復元経路へ統一する。
    focusActiveRow();
  }
}

function highlightPalette() {
  const el = document.getElementById('palette-grid');
  if (!el) return;
  [...el.children].forEach((btn, i) => btn.classList.toggle('active', i === paletteIndex));
  el.children[paletteIndex]?.scrollIntoView?.({ block: 'nearest' });
}

/** パレット表示中の矢印キー・Enter/Spaceでの選択（マウス必須を避ける） */
function handlePaletteKey(e) {
  const total = paletteOrder.length;
  if (e.code === 'ArrowRight') paletteIndex = Math.min(total - 1, paletteIndex + 1);
  else if (e.code === 'ArrowLeft') paletteIndex = Math.max(0, paletteIndex - 1);
  else if (e.code === 'ArrowDown') paletteIndex = Math.min(total - 1, paletteIndex + PALETTE_COLS);
  else if (e.code === 'ArrowUp') paletteIndex = Math.max(0, paletteIndex - PALETTE_COLS);
  else if (e.code === 'Enter' || e.code === 'Space') {
    insertPaletteItem(paletteIndex);
    togglePalette(false);
    return;
  } else {
    return; // 未対応キー: すでにpreventDefault済みなので何もしない
  }
  highlightPalette();
}

function togglePalette(force) {
  const el = document.getElementById('palette');
  const open = force ?? !el.classList.contains('open');
  el.classList.toggle('open', open);
  if (open) {
    paletteIndex = 0;
    highlightPalette();
  } else {
    focusActiveRow();
  }
}

// ---------------------------------------------------------------------------
// 入力方式プリセットと頻出記号の常駐列
// ---------------------------------------------------------------------------

const RESIDENT_SYMBOLS = [
  { label: '+', code: 'KeyG', group: 'operator' },
  { label: '−', code: 'KeyH', group: 'operator' },
  { label: '±', action: { type: 'op', symbol: '\\pm ' }, group: 'operator' },
  { label: '·', code: 'KeyT', group: 'operator' },
  { label: '=', code: 'KeyS', group: 'operator' },
  { label: '(…)', code: 'KeyF', group: 'structure' },
  { label: 'n/α', code: 'KeyL', group: 'structure' },
  { label: 'α/n', code: 'KeyJ', group: 'structure' },
  { label: '^', code: 'KeyD', group: 'structure' },
  { label: '√', code: 'KeyA', group: 'structure' },
];

function renderResidentSymbols() {
  const el = document.getElementById('resident-symbols');
  if (!el) return;
  el.innerHTML = '';
  for (const item of RESIDENT_SYMBOLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'resident-key';
    btn.dataset.group = item.group;
    btn.textContent = item.label;
    btn.setAttribute('aria-label', `常駐記号 ${item.label}`);
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const row = activeRow();
      const action = item.action ?? resolveAction(item.code, 'symbol', false);
      if (commitInputAction(row, action)) {
        btn.classList.add('is-pressed');
        setTimeout(() => btn.classList.remove('is-pressed'), 150);
      }
      focusActiveRow();
    });
    el.appendChild(btn);
  }
}

function updateInputMethodUI() {
  document.body.dataset.inputMethod = inputMethod;
  document.body.dataset.inputSystem = inputSystem;
  // 一時遷移の固定は出発層のhybridに属する。到着層がtoggle/math/holdでも
  // ボタンを消すと、利用者は「一時＋固定」の固定側を選べなくなる。
  document.body.dataset.temporaryLayer = String(temporaryTransition !== null && temporaryLayer !== null);
  document.querySelectorAll('.method-choice').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(inputSystem === 'legacy' && btn.dataset.inputMethod === inputMethod));
  });
  document.querySelectorAll('.input-system-choice').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.inputSystem === inputSystem));
  });
  document.getElementById('input-method-badge').textContent = inputSystem === 'conversion'
    ? '変換方式' : INPUT_METHODS[inputMethod].name;
}

function setInputMethod(methodId, persist = true, applyLayerPreset = persist) {
  if (!INPUT_METHODS[methodId]) return;
  cancelPhysicalLongPress();
  if (applyLayerPreset && inputSystem === 'conversion') {
    // 変換方式内では、全層へ同じ切替方法を置く初期プリセットとしても使える。
    for (const layer of INPUT_METHOD_LAYERS) layerInputMethods[layer] = methodId;
    saveLayerInputMethods();
  }
  inputMethod = methodId;
  if (inputSystem === 'legacy') legacyInputMethod = methodId;
  baseLayer = methodBaseLayer[methodId] ?? INPUT_METHODS[methodId].defaultLayer;
  temporaryLayer = null;
  temporaryTransition = null;
  virtualShift = false;
  if (persist) {
    try { localStorage.setItem(INPUT_METHOD_KEY, methodId); }
    catch (err) { console.warn('[neo-math] input method save failed', err); }
  }
  updateInputMethodUI();
  renderKeyGuide();
  const sidebar = document.getElementById('sidebar');
  if (sidebar?.open) {
    // 設定面が見えている間は、選択したボタンへフォーカスを残す。
    // 背面の数式欄へ戻すと Tab が設定項目の移動ではなく層切替として奪われる。
    renderSidebar();
  } else {
    focusActiveRow();
  }
}

function setInputSystem(systemId, persist = true) {
  if (!INPUT_SYSTEMS[systemId]) return;
  cancelPhysicalLongPress();
  // 系統を跨いで読みの途中状態を持ち越さない。途中の `s` や未確定IME文字を
  // 旧キー入力へ流さないため、切替時は明示的に取り消す。
  for (const row of rows) {
    if (!row.conversion) continue;
    row.conversion.preview.textContent = '';
    row.conversion.preview.hidden = true;
    row.conversion.raw = '';
    row.conversion.reading = '';
    row.conversion.searchReading = '';
    row.conversion.pending = '';
    row.conversion.navigation = false;
    row.conversion.selectedIndex = 0;
    row.conversion.candidates = [];
    row.conversion.shell.hidden = systemId !== 'conversion';
  }
  if (inputSystem === 'legacy') legacyInputMethod = inputMethod;
  inputSystem = systemId;
  temporaryLayer = null;
  temporaryTransition = null;
  virtualShift = false;
  if (inputSystem === 'conversion') {
    baseLayer = 'symbol';
    inputMethod = inputMethodForLayer(baseLayer);
  } else {
    inputMethod = legacyInputMethod;
    baseLayer = methodBaseLayer[inputMethod] ?? INPUT_METHODS[inputMethod].defaultLayer;
  }
  if (persist) {
    try { localStorage.setItem(INPUT_SYSTEM_KEY, inputSystem); }
    catch (err) { console.warn('[neo-math] input system save failed', err); }
  }
  updateInputMethodUI();
  syncSettingsCategoryAvailability();
  renderKeyGuide();
  const row = activeRow();
  if (inputSystem === 'conversion' && row) openConversion(row, true);
  else if (document.getElementById('sidebar')?.open) renderSidebar();
  else focusActiveRow();
  updateConversionCaret(activeRow());
}

document.querySelectorAll('.method-choice').forEach((btn) => {
  btn.addEventListener('click', () => setInputMethod(btn.dataset.inputMethod));
});
document.querySelectorAll('.input-system-choice').forEach((btn) => {
  btn.addEventListener('click', () => setInputSystem(btn.dataset.inputSystem));
});
document.querySelectorAll('.layout-mode-choice').forEach((btn) => {
  btn.addEventListener('click', () => setLayoutMode(btn.dataset.layoutMode));
});

// ---------------------------------------------------------------------------
// サイドバー（キーマップコンフィグ）
// ---------------------------------------------------------------------------

let configLayer = 'symbol';
let configCode = null;

// 割り当てに選べる中身。パレットの記号に加えて、構造キー（開き括弧・分数など）も選べる。
// 構造は素キーに無いと成立しないので、記号だけを並べたコンフィグにはしない。
const ASSIGNABLE = [
  { label: '文', action: { type: 'text' } },
  { label: '(…)', action: { type: 'open', kind: 'paren' } },
  { label: '^', action: { type: 'open', kind: 'sup' } },
  { label: '_', action: { type: 'open', kind: 'sub' } },
  { label: '√', action: { type: 'open', kind: 'sqrt' } },
  { label: '|…|', action: { type: 'open', kind: 'abs' } },
  { label: 'n/α', action: { type: 'nfrac' } },
  { label: 'α/n', action: { type: 'afrac' } },
  { label: 'lim', action: { type: 'lim' } },
  { label: 'Σ', action: { type: 'sum' } },
  { label: '+', action: { type: 'op', symbol: '+' } },
  { label: '-', action: { type: 'op', symbol: '-' } },
  { label: '=', action: { type: 'op', symbol: '=' } },
  { label: '∫', action: { type: 'literal', latex: '\\int ' } },
  { label: 'dx', action: { type: 'term-literal', latex: '\\,dx' } },
  { label: 'd/dx', action: { type: 'literal', latex: '\\frac{d}{dx}' } },
  { label: '→', action: { type: 'term-literal', latex: '\\to ' } },
  { label: '·', action: { type: 'literal', latex: '\\cdot ' } },
  { label: 'e', action: { type: 'term-literal', latex: 'e' } },
  { label: 'π', action: { type: 'term-literal', latex: '\\pi ' } },
  { label: 'i', action: { type: 'term-literal', latex: 'i' } },
  { label: '∞', action: { type: 'term-literal', latex: '\\infty ' } },
  { label: '≦', action: { type: 'literal', latex: '\\leqq ' } },
  { label: '≧', action: { type: 'literal', latex: '\\geqq ' } },
  { label: '≠', action: { type: 'literal', latex: '\\ne ' } },
  { label: 'sin', action: { type: 'func', name: 'sin' } },
  { label: 'cos', action: { type: 'func', name: 'cos' } },
  { label: 'tan', action: { type: 'func', name: 'tan' } },
  { label: 'log', action: { type: 'func', name: 'log' } },
  ...PALETTE_ITEMS.map(([label, latex]) => ({ label, action: { type: 'literal', latex } })),
];

function renderChoice(el, items, current, onPick) {
  el.innerHTML = '';
  for (const { value, label } of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.choiceValue = value;
    btn.textContent = label;
    btn.className = value === current ? 'active' : '';
    btn.addEventListener('click', () => {
      onPick(value);
      // MathLiveがpointerdownでフォーカスを奪うため、再描画後も同じ設定操作へ戻す。
      const next = el.querySelector(`[data-choice-value="${CSS.escape(String(value))}"]`);
      if (next instanceof HTMLElement) next.focus({ preventScroll: true });
    });
    el.appendChild(btn);
  }
}

function renderConversionPriorityControls() {
  const search = document.getElementById('conversion-priority-search');
  const list = document.getElementById('conversion-priority-list');
  if (!search || !list) return;
  search.value = conversionPrioritySearch;
  search.oninput = () => {
    conversionPrioritySearch = search.value;
    renderConversionPriorityControls();
  };
  const needle = normalizeConversionQuery(conversionPrioritySearch);
  const candidates = activeConversionCandidates()
    .filter((candidate) => !needle || [candidate.label, ...candidate.aliases]
      .some((value) => normalizeConversionQuery(value).includes(needle)))
    .sort((a, b) => (conversionManualPriority.priorities[b.id] ?? 0) - (conversionManualPriority.priorities[a.id] ?? 0)
      || b.basePriority - a.basePriority || a.label.localeCompare(b.label, 'ja'))
    .slice(0, needle ? 24 : 8);
  list.innerHTML = '';
  if (!candidates.length) {
    list.textContent = '一致する候補がありません';
    return;
  }
  for (const candidate of candidates) {
    const row = document.createElement('div');
    row.className = 'conversion-priority-row';
    const label = document.createElement('span');
    const symbol = document.createElement('b');
    symbol.textContent = candidate.label;
    const reading = document.createElement('small');
    const priority = conversionManualPriority.priorities[candidate.id] ?? 0;
    reading.textContent = `${candidate.aliases.slice(0, 2).join(' / ')}${priority ? ` · 手動 ${priority > 0 ? '+' : ''}${priority}` : ''}`;
    label.append(symbol, reading);
    row.appendChild(label);
    for (const [action, text] of [['up', '↑'], ['down', '↓'], ['top', '最上位']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.priorityAction = action;
      button.textContent = text;
      button.setAttribute('aria-label', `${candidate.label}を${action === 'up' ? '一段上げる' : action === 'down' ? '一段下げる' : '最上位にする'}`);
      button.addEventListener('click', () => {
        const current = conversionManualPriority.priorities[candidate.id] ?? 0;
        const next = action === 'top' ? 50 : current + (action === 'up' ? 1 : -1);
        conversionManualPriority = setManualPriority(conversionManualPriority, candidate.id, next, activeConversionCandidates());
        saveConversionPreferences({ profileChange: true });
        queueConversionProfileSave();
        renderConversionPriorityControls();
      });
      row.appendChild(button);
    }
    list.appendChild(row);
  }
}

// 段階4-6: 画面下のキーガイドは「どの物理キーがどの記号を出すか」のライブ表示に留まる
// （記号の割当はそれで足りている、と拓男から指摘済み）。ここは「操作」専用の一覧。
// Tabの説明だけは設定で変わる（入力方法・層ごとの切替方法）ため、固定文字列にせず
// 現在の割当を都度読んで表示する。他の操作（Ctrl+Z等・キャンバスの修飾キー）は
// このアプリでは割当変更の余地がないため、固定の説明でよい。
function renderOperationsGuide() {
  const list = document.getElementById('operations-guide-list');
  if (!list) return;
  const tabMethod = INPUT_METHODS[inputMethodForLayer(activeInputLayer())];
  const entries = [
    ['Tab', tabMethod?.note ?? 'レイヤーを切り替える、または変換候補をトグルする。'],
    ['Enter', '変換候補を確定する。文（\\text{}）の中では文を閉じる。'],
    ['矢印キー', '数式内でカーソルを移動する。候補一覧を出しているときは候補間を移動する。'],
    ['Escape', '記号層へ戻す。パレット（ギリシャ文字・低頻度記号）を開閉する。'],
    ['Backspace', '通常は1文字戻す。確定した直後だけは、確定結果を読みへ戻して打ち直せる（段階2で追加）。'],
    ['Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y', '取り消し / やり直し。'],
    ['Ctrl+C / Ctrl+V', '選択中のブロック（キャンバスで複数選択時はまとめて）をコピー・貼り付けする。'],
    ['キャンバス: 空白を左ドラッグ', 'カメラ（表示位置）を動かす。'],
    ['キャンバス: ブロックの余白をドラッグ', 'ブロックを移動する。'],
    ['キャンバス: Alt+ドラッグ', 'つかんだブロックを複製し、複製のほうを動かす（元は残る）。'],
    ['キャンバス: Shift+ドラッグ（空白）', '矩形選択でブロックをまとめて選ぶ。'],
    ['キャンバス: 選択中のDelete/Backspace', '選択したブロックをまとめて削除する。'],
    ['「文」キー', '文章ブロック（\\text{}）の出入り。開いている文の上でもう一度押すと閉じる。'],
  ];
  list.replaceChildren();
  for (const [key, description] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = description;
    list.append(dt, dd);
  }
}

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar?.open) return;
  renderOperationsGuide();

  // 再描画しても、利用者が押していた設定側のコントロールを操作の中心に保つ。
  const activeElement = document.activeElement;
  const previousFocus = sidebar.contains(activeElement) ? {
    choiceValue: activeElement?.dataset?.choiceValue || null,
    code: activeElement?.dataset?.code || null,
    assignLabel: activeElement?.dataset?.assignLabel || null,
  } : null;

  // キー操作モード。元の「全キー横取り」版もここから選べる（ユーザー要望）。
  renderChoice(
    document.getElementById('capture-choice'),
    [
      { value: 'accessible', label: '入力＋画面操作（推奨）' },
      { value: 'original', label: '数式優先（旧動作）' },
    ],
    keyCaptureMode,
    (m) => setKeyCaptureMode(m),
  );

  // 単元プリセット（科目→単元の2段）。全単元ノートではキーガイドだけを切り替え、
  // 個別ノートではノートの学習範囲と常に同じ値へ更新する。
  const unitScopeNote = document.getElementById('unit-scope-note');
  if (unitScopeNote) unitScopeNote.textContent = noteUnitScope === ALL_UNITS_ID
    ? 'このノートは「全単元」です。ここで選ぶとキーガイドとパレットの表示順だけが変わります。'
    : `このノートは「${unitLabel(noteUnitScope)}」です。選ぶとノートの単元も切り替わります。`;
  renderChoice(
    document.getElementById('unit-subject-choice'),
    [{ value: ALL_UNITS_ID, label: '全単元' }, ...SUBJECTS.map((s) => ({ value: s.id, label: s.label }))],
    currentSubject,
    (id) => {
      if (id === ALL_UNITS_ID) {
        if (noteUnitScope === ALL_UNITS_ID) setCurrentUnit(ALL_UNITS_ID);
        else setNoteUnitScope(ALL_UNITS_ID);
      } else {
        const subject = SUBJECTS.find((s) => s.id === id);
        const unitId = subject?.units[0]?.id;
        if (!unitId) return;
        if (noteUnitScope === ALL_UNITS_ID) setCurrentUnit(unitId);
        else setNoteUnitScope(unitId);
      }
      renderSidebar();
    },
  );
  const subject = SUBJECTS.find((s) => s.id === currentSubject);
  const unitChoice = document.getElementById('unit-choice');
  if (unitChoice) unitChoice.hidden = !subject;
  renderChoice(
    unitChoice,
    (subject?.units ?? []).map((u) => ({ value: u.id, label: u.label })),
    currentUnit,
    (id) => { if (noteUnitScope === ALL_UNITS_ID) setCurrentUnit(id); else setNoteUnitScope(id); renderSidebar(); },
  );

  // 入力方式ごとの基底層（記号／英字を入れ替え）。方式ごとに独立して保存する。
  for (const methodId of Object.keys(INPUT_METHODS)) {
    const el = document.getElementById(`method-base-${methodId}`);
    if (!el) continue;
    renderChoice(
      el,
      [{ value: 'symbol', label: '記号' }, { value: 'latin', label: '英字' }],
      methodBaseLayer[methodId],
      (v) => { setMethodBaseLayer(methodId, v); renderSidebar(); },
    );
  }

  // 変換方式だけの層別設定。変換用層は専用IME、英字・ギリシャは既存キーマップを使い、
  // それぞれに4種類の切替方法を持たせる。
  for (const layer of INPUT_METHOD_LAYERS) {
    const el = document.getElementById(`layer-method-${layer}`);
    if (!el) continue;
    renderChoice(
      el,
      Object.entries(INPUT_METHODS).map(([value, definition]) => ({ value, label: definition.name })),
      layerInputMethods[layer],
      (methodId) => { setLayerInputMethod(layer, methodId); renderSidebar(); },
    );
  }
  renderConversionPriorityControls();

  renderChoice(
    document.getElementById('layer-choice'),
    LAYERS.map((l) => ({ value: l, label: inputSystem === 'conversion' && l === 'symbol' ? '変換用（キー設定）' : LAYER_NAMES[l] })),
    configLayer,
    (l) => { configLayer = l; configCode = null; renderSidebar(); },
  );

  // 設定側のキー一覧も、ガイドと同じ物理配列で描く。
  // ここだけ一覧順にすると「ガイドで見た場所」と「設定で押す場所」がずれる。
  const keysEl = document.getElementById('config-keys');
  keysEl.innerHTML = '';
  physicalRows.forEach((rowCodes) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'key-row compact';
    for (const code of rowCodes) {
      const cap = keyCap(code, configLayer, true, false, { selectableOnly: true });
      cap.classList.add('selectable');
      if (code === configCode) cap.classList.add('selected');
      cap.addEventListener('click', (event) => {
        configCode = code;
        renderSidebar();
        // キーボードで選んだとき（detail 0）は、そのまま割り当てを選べる位置へ送る。
        // マウスで選んだときは押した場所に留め、視線と手を動かさない。
        const target = event.detail === 0
          ? document.querySelector('#assign-grid .assign-btn')
          : keysEl.querySelector(`.key-cap[data-code="${CSS.escape(code)}"]`);
        if (target instanceof HTMLElement) target.focus({ preventScroll: true });
      });
      rowEl.appendChild(cap);
    }
    keysEl.appendChild(rowEl);
  });

  const assign = document.getElementById('assign-section');
  assign.hidden = configCode === null;
  if (configCode) {
    const current = labelFor(configCode, configLayer) ?? '未割り当て';
    document.getElementById('assign-title').textContent =
      `${keyDisplayName(configCode)}キー（${LAYER_NAMES[configLayer]}）: 現在 ${current}`;
    const grid = document.getElementById('assign-grid');
    grid.innerHTML = '';
    for (const item of ASSIGNABLE) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'assign-btn';
      btn.textContent = item.label;
      btn.dataset.assignLabel = item.label;
      btn.dataset.code = configCode;
      const currentAction = actionFor(configCode, configLayer, false);
      const usedOnPhysicalKey = physicalRows.flat().some((code) => (
        JSON.stringify(actionFor(code, configLayer, false)) === JSON.stringify(item.action)
      ));
      if (!usedOnPhysicalKey) btn.classList.add('unassigned-candidate');
      if (JSON.stringify(currentAction) === JSON.stringify(item.action)) btn.classList.add('current-assignment');
      btn.addEventListener('click', () => {
        setOverride(configCode, configLayer, item.action, item.label);
        renderKeyGuide();
        renderSidebar();
        grid.querySelector(`[data-assign-label="${CSS.escape(item.label)}"]`)
          ?.focus({ preventScroll: true });
      });
      grid.appendChild(btn);
    }
    document.getElementById('assign-reset').onclick = () => {
      clearOverride(configCode, configLayer);
      renderKeyGuide();
      renderSidebar();
      document.getElementById('assign-reset')?.focus({ preventScroll: true });
    };
  }

  const n = overrideCount();
  document.getElementById('override-count').textContent =
    n === 0 ? '叩き台のまま（変更なし）' : `叩き台から ${n} キーを変更中`;

  if (!previousFocus) return;
  let nextFocus = null;
  if (previousFocus.choiceValue) {
    nextFocus = sidebar.querySelector(`[data-choice-value="${CSS.escape(previousFocus.choiceValue)}"]`);
  } else if (previousFocus.code && sidebar.contains(activeElement)) {
    nextFocus = sidebar.querySelector(`#config-keys .key-cap[data-code="${CSS.escape(previousFocus.code)}"]`);
  } else if (previousFocus.assignLabel) {
    nextFocus = sidebar.querySelector(`[data-assign-label="${CSS.escape(previousFocus.assignLabel)}"]`);
  }
  if (nextFocus instanceof HTMLElement && !nextFocus.disabled) {
    nextFocus.focus({ preventScroll: true });
  }
}

// 通常数式の変換方式では、OS IMEを起動できるMathLiveのkeyboard sinkを避ける。
// 文章\text{}の中と従来方式だけをMathLive本体へ渡す。
function focusRowInput(row = activeRow(), preferKeyboardSink = false) {
  if (!row?.mf) return;
  if (isShikitypeTransformLayer() && !isNativeTextEntry(row)) {
    row.inputProxy?.focus({ preventScroll: true });
    return;
  }
  const mf = row.mf;
  const sink = mf.shadowRoot?.querySelector('.ML__keyboard-sink');
  // アカウントのdialogを閉じた直後は、MathLiveホストのfocus()が切替前の内部状態を
  // 読んで例外にする版がある。実際の入力先であるsinkが既にあれば先にそこへ戻し、
  // ホストの再初期化を避ける。
  if (preferKeyboardSink && sink instanceof HTMLElement) {
    sink.focus();
    if (document.activeElement === mf) return;
  }

  row.appClaimingFocus = true;
  try { row.focusMathField?.(); }
  finally { row.appClaimingFocus = false; }
  if (document.activeElement !== mf) {
    sink?.focus();
  }
}

// switchMode('math')直後のMathLiveは内部keyboard sinkへ一度だけfocusを戻す版がある。
// 直後と次フレームの両方で非編集proxyへ戻し、OS IMEが数式へ復帰する隙を残さない。
function focusProxyAfterNativeClose(row) {
  row?.inputProxy?.focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (activeRow() === row && !row.nativeTextOpen) row.inputProxy?.focus({ preventScroll: true });
  }));
}

function focusActiveRow(preferKeyboardSink = false) {
  focusRowInput(activeRow(), preferKeyboardSink);
}

let settingsOpener = null;
let activeSettingsCategory = 'basic';
const settingsScrollPositions = new Map();
const SETTINGS_SEARCH_ITEMS = [
  ['basic', '入力系統', '従来方式 変換方式', 'input-system-section'], ['basic', '編集面', '行 キャンバス', 'layout-mode-section'], ['basic', '単元プリセット', '科目 単元', 'unit-subject-choice'], ['basic', 'キー操作モード', 'キー捕捉', 'capture-choice'],
  ['input', '従来方式の入力方法', '標準トグル 数式常駐 一時 固定 長押し', 'legacy-input-method-section'], ['input', '変換方式の層ごとの切替方法', '変換 英字 ギリシャ', 'conversion-layer-method-section'], ['input', '方式ごとの基底層', '記号 英字', 'legacy-method-base-section'],
  ['conversion', '変換候補の優先順位', '候補 読み 優先', 'conversion-priority-section'], ['conversion', '読み辞書 CSV', 'インポート エクスポート', 'conversion-dictionary-section'],
  ['keys', '操作', 'Tab Enter Escape Backspace Ctrl 取り消し コピー 貼り付け キャンバス 複製 矩形選択 文章', 'operations-guide-section'],
  ['keys', '編集する層', 'キー 割当', 'layer-choice'], ['keys', '割り当て先', '物理キーボード', 'assign-section'], ['appearance', 'デザイン', 'テーマ 外観', 'sidebar-theme-choice'],
];

function organizeSettingsPanels() {
  const basic = document.getElementById('settings-panel-basic');
  const input = document.getElementById('settings-panel-input');
  const conversion = document.getElementById('settings-panel-conversion');
  if (!basic || !input || !conversion) return;
  const unit = [...document.querySelectorAll('.side-section')].find((el) => el.querySelector('#unit-subject-choice'));
  const capture = [...document.querySelectorAll('.side-section')].find((el) => el.querySelector('#capture-choice'));
  for (const section of [document.getElementById('input-system-section'), document.getElementById('layout-mode-section'), unit, capture]) if (section) basic.append(section);
  for (const section of [document.getElementById('legacy-input-method-section'), document.getElementById('conversion-layer-method-section'), document.getElementById('legacy-method-base-section')]) if (section) input.append(section);
  for (const section of [document.getElementById('conversion-priority-section'), document.getElementById('conversion-dictionary-section')]) if (section) conversion.append(section);
}

function isSettingsCategoryAvailable(category) {
  // 変換方式でない間は、変換の右paneは意図的に空になる。空画面を残さず、
  // nav・検索・Tab順からまとめて外す。
  return category !== 'conversion' || inputSystem === 'conversion';
}

function syncSettingsCategoryAvailability() {
  const conversionNav = document.querySelector('.settings-nav-item[data-settings-category="conversion"]');
  if (conversionNav) conversionNav.hidden = !isSettingsCategoryAvailable('conversion');
  if (!isSettingsCategoryAvailable(activeSettingsCategory)) activeSettingsCategory = 'input';
  if (document.getElementById('sidebar')?.open) selectSettingsCategory(activeSettingsCategory);
}

function selectSettingsCategory(category, targetId = '') {
  const content = document.getElementById('settings-content');
  if (!content) return;
  if (!isSettingsCategoryAvailable(category)) category = 'input';
  // キー割当は選択先が空だと右ペインが「何をすればよいか」だけになってしまう。
  // 最初の物理キーを安全な初期選択にして、配列と詳細を同じ視野へ常に出す。
  if (category === 'keys' && configCode === null) { configCode = physicalRows.flat()[0] ?? null; renderSidebar(); }
  settingsScrollPositions.set(activeSettingsCategory, content.scrollTop);
  activeSettingsCategory = category;
  document.querySelectorAll('.settings-panel').forEach((panel) => { panel.hidden = panel.dataset.settingsCategory !== category; });
  document.querySelectorAll('.settings-nav-item').forEach((button) => button.setAttribute('aria-current', button.dataset.settingsCategory === category ? 'page' : 'false'));
  content.scrollTop = targetId ? 0 : (settingsScrollPositions.get(category) ?? 0);
  const target = targetId ? document.getElementById(targetId) : null;
  if (target) requestAnimationFrame(() => {
    // scrollIntoView() はdialog外のscroll containerを選ぶブラウザがあり、検索結果が
    // 同じカテゴリの先頭に戻るだけになる。右content自身の座標として明示的に移動する。
    const contentRect = content.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    content.scrollTo({ top: Math.max(0, content.scrollTop + targetRect.top - contentRect.top - 12), behavior: 'auto' });
    target.classList.add('settings-search-hit');
    setTimeout(() => target.classList.remove('settings-search-hit'), 1100);
  });
}

function renderSettingsSearch() {
  const input = document.getElementById('settings-search');
  const results = document.getElementById('settings-search-results');
  if (!input || !results) return;
  const query = normalizeConversionQuery(input.value);
  results.replaceChildren(); results.hidden = !query;
  if (!query) return;
  const matches = SETTINGS_SEARCH_ITEMS.filter(([category, title, description]) => isSettingsCategoryAvailable(category)
    && normalizeConversionQuery(`${title} ${description}`).includes(query)).slice(0, 7);
  if (!matches.length) { results.textContent = '一致する設定がありません'; return; }
  for (const [category, title, description, targetId] of matches) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-search-result';
    button.textContent = `${title} — ${description}`;
    button.onclick = () => { input.value = ''; results.hidden = true; selectSettingsCategory(category, targetId); };
    results.append(button);
  }
}

function toggleSidebar(open) {
  const sidebar = document.getElementById('sidebar');
  const next = open ?? !sidebar.open;
  // 閉じる前にフォーカスを外す。display:none になる要素へフォーカスが残ると、
  // 次の1クリックがBODYへ吸われて打鍵が1回分死ぬ（実測で確認）。
  if (!next && sidebar.contains(document.activeElement)) document.activeElement.blur();
  document.getElementById('sidebar-toggle').setAttribute('aria-expanded', String(next));
  document.body.classList.toggle('sidebar-open', next);
  if (next) {
    settingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : document.getElementById('sidebar-toggle');
    organizeSettingsPanels();
    if (!sidebar.open) sidebar.showModal();
    renderSidebar();
    selectSettingsCategory(activeSettingsCategory);
    // dialog表示中に背景の入力位置だけが点滅すると視線が分断される。
    // focusはdialogへ移し、専用caretもここで明示的に伏せる。
    for (const row of rows) if (row.caret) row.caret.hidden = true;
    // F2で開いたときにキーボードだけで設定へ入れるよう、先頭の選択肢へフォーカスする。
    const first = sidebar.querySelector('#settings-search, button:not([disabled])');
    if (first) first.focus();
  } else {
    if (sidebar.open) sidebar.close();
    // 設定を閉じたら、開く前の起点ボタンではなく編集中の式へ復帰する。
    // これでEsc後も物理キーボードを途切れずに使え、変換方式ではproxyと
    // 論理caretを同時に戻せる。
    focusActiveRow();
    updateConversionCaret(activeRow());
  }
}

document.getElementById('sidebar-toggle')?.addEventListener('click', () => toggleSidebar());
document.getElementById('sidebar-close')?.addEventListener('click', () => toggleSidebar(false));
document.querySelectorAll('.settings-nav-item').forEach((button) => button.addEventListener('click', () => selectSettingsCategory(button.dataset.settingsCategory)));
document.getElementById('settings-search')?.addEventListener('input', renderSettingsSearch);
document.getElementById('sidebar')?.addEventListener('cancel', (event) => { event.preventDefault(); toggleSidebar(false); });
document.getElementById('sidebar')?.addEventListener('close', () => {
  document.body.classList.remove('sidebar-open');
  document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', 'false');
});
document.getElementById('new-note')?.addEventListener('click', openNewNoteDialog);
document.getElementById('new-note-dialog-close')?.addEventListener('click', closeNewNoteDialog);
document.getElementById('new-note-dialog')?.addEventListener('cancel', (event) => { event.preventDefault(); closeNewNoteDialog(); });
document.getElementById('new-note-create')?.addEventListener('click', () => {
  closeNewNoteDialog();
  createNewNote(newNoteUnitChoice);
});
document.getElementById('guide-unit-switch')?.addEventListener('click', openGuideUnitDialog);
document.getElementById('guide-unit-dialog-close')?.addEventListener('click', () => document.getElementById('guide-unit-dialog')?.close());
document.getElementById('guide-unit-dialog')?.addEventListener('cancel', (event) => { event.preventDefault(); event.currentTarget.close(); focusActiveRow(); });
document.getElementById('notes-toggle')?.addEventListener('click', () => toggleNotesList());
document.getElementById('notes-search')?.addEventListener('input', (event) => {
  notesFilterQuery = event.target.value;
  renderNotesList();
});
document.getElementById('notes-trash-toggle')?.addEventListener('click', () => {
  notesTrashOpen = !notesTrashOpen;
  renderNotesList();
});
document.getElementById('export-note-toggle')?.addEventListener('click', () => toggleExportMenu());
document.getElementById('export-note-latex-copy')?.addEventListener('click', async (event) => {
  const ok = await copyNoteLatexToClipboard();
  flashButtonFeedback(event.currentTarget, ok, { okText: 'コピーしました', failText: '書き出す式がありません' });
});
document.getElementById('export-note-latex-download')?.addEventListener('click', (event) => {
  const ok = downloadNoteLatex();
  if (!ok) flashButtonFeedback(event.currentTarget, false, { failText: '書き出す式がありません' });
  else toggleExportMenu(false);
});
window.addEventListener('beforeunload', saveCurrentNoteNow);
document.getElementById('reset-all')?.addEventListener('click', () => {
  clearAllOverrides();
  configCode = null;
  renderKeyGuide();
  renderSidebar();
});
document.getElementById('conversion-priority-reset')?.addEventListener('click', () => {
  conversionManualPriority = resetManualPriorities();
  saveConversionPreferences({ profileChange: true });
  queueConversionProfileSave();
  renderConversionPriorityControls();
});

function setConversionDictionaryStatus(message, isError = false) {
  const status = document.getElementById('conversion-dictionary-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

async function importConversionDictionaryFromFile(mode) {
  const input = document.getElementById('conversion-dictionary-file');
  const file = input?.files?.[0];
  if (!file) { setConversionDictionaryStatus('先にCSVファイルを選んでください。', true); return; }
  if (file.size > 128 * 1024) { setConversionDictionaryStatus('CSVは128KiB以内にしてください。', true); return; }
  let text;
  try { text = await file.text(); }
  catch { setConversionDictionaryStatus('CSVを読み込めませんでした。', true); return; }
  const result = importConversionDictionaryCsv(text, conversionDictionary, { mode });
  if (result.accepted) {
    applyConversionDictionary(result.state);
    queueConversionProfileSave();
  }
  const details = result.rejected.slice(0, 3).map((item) => `${item.line}行目: ${item.reason}`);
  const resultCopy = `${result.accepted}行を反映${result.rejected.length ? `、${result.rejected.length}行を拒否` : ''}しました。`;
  setConversionDictionaryStatus(details.length ? `${resultCopy} ${details.join(' / ')}` : resultCopy, Boolean(result.rejected.length));
  if (result.accepted) {
    renderSidebar();
    // CSVファイル経由の反映も、開いていれば表エディタへ映す（未保存編集があるときは壊さない）。
    dictionaryTablePanel?.refresh();
  }
}

function exportConversionDictionary() {
  const csv = exportConversionDictionaryCsv(conversionDictionary);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = 'shikitype-reading-dictionary.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
  setConversionDictionaryStatus(`${activeConversionCandidates().length}候補をCSVへ書き出しました。`);
}

document.getElementById('conversion-dictionary-import')?.addEventListener('click', () => { void importConversionDictionaryFromFile('merge'); });
document.getElementById('conversion-dictionary-replace')?.addEventListener('click', () => { void importConversionDictionaryFromFile('replace'); });
document.getElementById('conversion-dictionary-export')?.addEventListener('click', exportConversionDictionary);

// 設定モーダル内で読み辞書を直接編集する（単体HTML tools/reading-dictionary-csv-editor.htmlと
// 往復せずに済ませるための組み込み版。単体HTML自体は変更しておらず、引き続き単体でも使える）。
let dictionaryTablePanel = null;
function mountDictionaryTablePanel() {
  const root = document.getElementById('dictionary-editor-panel');
  if (!root || dictionaryTablePanel) return;
  dictionaryTablePanel = createDictionaryTablePanel(root, {
    getDictionary: () => exportConversionDictionaryCsv(conversionDictionary),
    applyReplace: (csvText) => {
      const result = importConversionDictionaryCsv(csvText, conversionDictionary, { mode: 'replace' });
      applyConversionDictionary(result.state);
      queueConversionProfileSave();
      return result;
    },
    onStatus: (message, isError) => setConversionDictionaryStatus(message, isError),
  });
}
mountDictionaryTablePanel();

// ---------------------------------------------------------------------------
// 5つのデザイン方向。入力DOMは一切作り直さず、bodyのテーマだけを差し替える。
// 切替時に数式欄へフォーカスを戻すため、そのまま打鍵を続けられる。
// ---------------------------------------------------------------------------

const THEMES = {
  '06': '国際数学誌編集室',
  '08': '文庫の未来',
  '09': '光学実験台',
  '13': '未来の資料室',
  '18': '数式美術館',
};
const THEME_KEY = 'neo-math.theme.v1';
const RAIL_COLLAPSED_KEY = 'neo-math.theme-rail-collapsed.v1';

function applyThemeRailCollapsed(collapsed, persist = true) {
  document.body.classList.toggle('theme-rail-collapsed', collapsed);
  const btn = document.getElementById('theme-rail-collapse');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? 'デザインバーを開く' : 'デザインバーを畳む');
    btn.textContent = collapsed ? '›' : '‹';
  }
  if (persist) {
    try { localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0'); }
    catch (err) { console.warn('[neo-math] theme rail save failed', err); }
  }
}

const themeRailCollapse = document.getElementById('theme-rail-collapse');

function toggleThemeRailFromButton(btn) {
  applyThemeRailCollapsed(!document.body.classList.contains('theme-rail-collapsed'));
  // 親レールを完全退避しても、Space/Enterで連続して戻せるよう入口へ残す。
  btn.focus({ preventScroll: true });
}

function focusAfterAccountDialogClose(frame = 0) {
  const row = activeRow();
  const mf = row?.mf;
  if (isShikitypeTransformLayer() && row && !isNativeTextEntry(row)) {
    requestAnimationFrame(fitCanvasRowsToViewport);
    focusRowInput(row);
    return;
  }
  const sink = mf?.shadowRoot?.querySelector('.ML__keyboard-sink');
  // ストア切替で再生成されたMathLiveは、接続直後にsinkへfocusすると旧モデルを
  // 参照して例外になることがある。8フレーム待ってから実入力先だけへ戻す。
  // 60Hzでも約133msで、閉鎖直後にそのまま入力できる目標（450ms）内に収まる。
  if (!mf?.isConnected || !(sink instanceof HTMLElement) || frame < 8) {
    if (frame < 20) requestAnimationFrame(() => focusAfterAccountDialogClose(frame + 1));
    return;
  }
  requestAnimationFrame(fitCanvasRowsToViewport);
  sink.focus();
}

themeRailCollapse?.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' && event.code !== 'Enter') return;
  // 数式欄の全キー捕捉を経由せず、ボタン自身が一度だけ開閉する。
  event.preventDefault();
  event.stopPropagation();
  toggleThemeRailFromButton(event.currentTarget);
});

themeRailCollapse?.addEventListener('click', (event) => {
  // Enter/Spaceはkeydownで処理済み。detail=0のキーボードclickは重ねない。
  if (event.detail === 0) {
    event.preventDefault();
    return;
  }
  toggleThemeRailFromButton(event.currentTarget);
});

function applyTheme(themeId, persist = true) {
  if (!THEMES[themeId]) return;
  document.body.dataset.theme = themeId;
  document.querySelectorAll('.theme-choice').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === themeId));
  });
  if (persist) {
    try { localStorage.setItem(THEME_KEY, themeId); }
    catch (err) { console.warn('[neo-math] theme save failed', err); }
  }
}

document.querySelectorAll('.theme-choice').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    applyTheme(btn.dataset.theme);
    // 設定面から触ったときは設定内の操作を続けられるようにする。
    // 左レールから触ったときだけ、そのまま打鍵へ戻る。
    if (!btn.closest('#sidebar')) focusActiveRow();
  });
});

try { applyTheme(localStorage.getItem(THEME_KEY) || '09', false); }
catch { applyTheme('09', false); }

try { applyThemeRailCollapsed(localStorage.getItem(RAIL_COLLAPSED_KEY) === '1', false); }
catch { applyThemeRailCollapsed(false, false); }

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// アカウントとクラウドノート
// ログアウト時は匿名ストア、ログイン時はユーザーごとのストアを必ず分ける。
// API がない従来の静的配信でも、ローカル保存だけで編集を継続できる。
// ---------------------------------------------------------------------------

const CLOUD_API = '/api';
const CLOUD_NOTE_LIMIT = 100;
const CLOUD_NOTE_BYTES_LIMIT = 220000;
let activeAccountPanel = 'login';

function updateCloudStatus(state = cloudAccount.state) {
  cloudAccount.state = state;
  const status = document.getElementById('sync-status');
  const detail = document.getElementById('account-sync-detail');
  const copy = {
    local: 'この端末に保存',
    // 未ログイン時だけの表示（3. 保存された感）。ログイン後はクラウドの
    // saving/savedがここより先に出るため、local-*はcloudAccount.userIdが
    // 無いときしか呼ばれない。
    'local-saving': '保存中…',
    'local-saved': '保存済み',
    saving: 'クラウドへ保存中',
    saved: 'クラウドに保存済み',
    offline: 'オフライン保存',
    error: 'この端末に保存（同期待ち）',
    limit: 'この端末に保存（クラウドの100件上限）',
  }[state] ?? 'この端末に保存';
  if (status) status.textContent = copy;
  if (detail) detail.textContent = cloudAccount.userId ? copy : '';
  // 狭幅では#sync-statusを視覚的に隠す（ヘッダーに置き場が無いため）。ただし
  // 「保存中/保存済み」自体は消えたことにせず、account-toggleへ小さな点で
  // 出す（3. 保存された感、狭幅版）。対象はローカル未ログイン時の2状態だけに
  // 絞り、ログイン時のクラウド表示は既存どおり変更しない。
  document.body.dataset.localSaveHint = (state === 'local-saving' || state === 'local-saved') ? state : '';
  updateConversionDictionaryStorageStatus(state);
}

function updateConversionDictionaryStorageStatus(state = cloudAccount.state) {
  const status = document.getElementById('conversion-dictionary-storage');
  if (!status) return;
  if (!cloudAccount.userId) {
    status.textContent = '保存先：この端末（未ログイン）';
    return;
  }
  if (conversionProfileConflict) {
    status.textContent = `保存先：${cloudAccount.userId} のクラウド（競合。ローカルの変更を保持中）`;
    return;
  }
  const sync = {
    loading: '同期を確認中',
    pending: '同期待ち',
    saving: '同期中',
    saved: '同期済み',
    offline: '同期待ち（オフライン）',
    error: '同期待ち',
    limit: '同期できません',
  }[state] ?? '同期を確認中';
  status.textContent = `保存先：${cloudAccount.userId} のクラウド（${sync}）`;
}

function setAccountMessage(message = '', error = false) {
  const el = document.getElementById('account-message');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = error ? 'error' : '';
}

async function apiJson(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${CLOUD_API}${path}`, { ...options, headers, credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || '通信に失敗しました');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

let latestReviewResult = null;
let reviewSubmitting = false;
let reviewHistory = [];
let reviewHistoryNoteId = null;
let reviewResumeAfterLogin = false;

function setReviewStatus(message = '', error = false) {
  const status = document.getElementById('review-status');
  if (!status) return;
  status.textContent = message;
  status.dataset.error = error ? 'true' : '';
}

function reviewBlocksSnapshot() {
  return rows
    .map((row) => ({ id: row.id, latex: String(row.mf.value || '') }))
    .filter((block) => block.latex.replace(/\\placeholder\{\}/g, '').trim());
}

function reviewSnapshotKey() {
  return JSON.stringify(reviewBlocksSnapshot());
}

function reviewResultIsStale() {
  const note = notesStore.notes.find((entry) => entry.id === notesStore.activeId);
  if (!latestReviewResult || !note) return false;
  return latestReviewResult.snapshotKey !== reviewSnapshotKey()
    || Boolean(latestReviewResult.noteUpdatedAt && note._cloudUpdatedAt && latestReviewResult.noteUpdatedAt !== note._cloudUpdatedAt);
}

function refreshReviewStaleState() {
  const stale = document.getElementById('review-stale');
  if (!stale || !latestReviewResult) return;
  stale.textContent = 'この結果の後にノートが編集されています。';
  stale.hidden = !reviewResultIsStale();
}

function focusReviewBlock(blockId) {
  const row = rows.find((entry) => entry.id === blockId);
  if (!row) {
    const stale = document.getElementById('review-stale');
    if (stale) { stale.textContent = 'この見直し時の数式ブロックは、現在のノートにはありません。'; stale.hidden = false; }
    return;
  }
  document.getElementById('review-dialog')?.close();
  claimRowFocus(row);
  if (layoutMode === 'canvas') {
    const position = rowWorldPosition(row, rows.indexOf(row));
    const bounds = canvasViewport.getBoundingClientRect();
    canvasCamera = { ...canvasCamera, x: bounds.width / 2 - position.x * canvasCamera.zoom, y: bounds.height / 2 - position.y * canvasCamera.zoom };
    renderLayoutMode();
  } else row.wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function renderReviewResult(result) {
  latestReviewResult = { ...result, snapshotKey: JSON.stringify(Array.isArray(result.snapshot) ? result.snapshot : reviewBlocksSnapshot()) };
  document.getElementById('review-setup').hidden = true;
  const section = document.getElementById('review-result');
  section.hidden = false;
  const card = result.card || {};
  const strengths = document.getElementById('review-strengths');
  strengths.replaceChildren();
  for (const text of card.strengths?.length ? card.strengths : ['ここまでの式を確認しています。']) {
    const item = document.createElement('li'); item.textContent = text; strengths.append(item);
  }
  const corrections = document.getElementById('review-corrections');
  corrections.replaceChildren();
  if (card.corrections?.length) {
    for (const correction of card.corrections) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'review-correction'; button.textContent = correction.text;
      if (correction.blockId) button.addEventListener('click', () => focusReviewBlock(correction.blockId));
      else button.disabled = true;
      corrections.append(button);
    }
  } else corrections.textContent = '直す箇所は見つかりませんでした。';
  document.getElementById('review-next-step').textContent = card.nextStep || '';
  refreshReviewStaleState();
  const trace = document.getElementById('review-stage-list');
  trace.replaceChildren();
  const labels = { independent_solver: '独立した解法を作成', solution_auditor: '答案と照合', falsifier: '診断を再検証', tutor: '最小のヒントに整理', single: '通常の見直し' };
  for (const stage of result.stages || []) {
    const item = document.createElement('li');
    item.textContent = stage.skipped ? `${labels[stage.stage] || stage.stage}（${stage.reason || '条件を満たさず省略'}）` : (labels[stage.stage] || stage.stage);
    trace.append(item);
  }
  document.getElementById('review-trace').hidden = !(result.stages?.length);
}

function renderReviewHistory() {
  const list = document.getElementById('review-history-list');
  const details = document.getElementById('review-history');
  if (!list || !details) return;
  list.replaceChildren();
  details.hidden = reviewHistory.length === 0;
  for (const entry of reviewHistory.slice(0, 6)) {
    if (!entry?.result) continue;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'review-history-item';
    const time = new Date(entry.createdAt || entry.completedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    button.textContent = `${time} · ${entry.reviewKind === 'hint' ? '途中のヒント' : '解き終わりのレビュー'}`;
    button.addEventListener('click', () => renderReviewResult({ ...entry.result, snapshot: entry.snapshot }));
    list.append(button);
  }
}

async function loadReviewHistory(noteId) {
  if (!cloudAccount.userId || !noteId) { reviewHistory = []; renderReviewHistory(); return; }
  try {
    const payload = await apiJson(`/notes/${encodeURIComponent(noteId)}/reviews`);
    if (notesStore.activeId !== noteId || !cloudAccount.userId) return;
    reviewHistory = Array.isArray(payload.reviews) ? payload.reviews : [];
    reviewHistoryNoteId = noteId;
    renderReviewHistory();
  } catch {
    // 見直し履歴を取得できないだけで、ノートの入力・新規見直しは止めない。
  }
}

function openReviewDialog({ focusProblem = true } = {}) {
  const dialog = document.getElementById('review-dialog');
  if (!dialog) return;
  document.getElementById('review-result').hidden = true;
  document.getElementById('review-setup').hidden = false;
  setReviewStatus(cloudAccount.userId ? '問題文と、いまのノートの式を使います。' : '見直しにはログインが必要です。', !cloudAccount.userId);
  document.getElementById('review-login').hidden = Boolean(cloudAccount.userId);
  if (!dialog.open) dialog.showModal();
  const noteId = notesStore.activeId;
  if (noteId && (reviewHistoryNoteId !== noteId || !reviewHistory.length)) void loadReviewHistory(noteId);
  if (focusProblem) setTimeout(() => document.getElementById('review-problem')?.focus(), 0);
}

async function submitReview() {
  if (reviewSubmitting) return;
  if (!cloudAccount.userId) { setReviewStatus('ログインしてから見直してください。入力内容はそのまま残ります。', true); return; }
  const problem = document.getElementById('review-problem')?.value?.trim() || '';
  const blocks = reviewBlocksSnapshot();
  if (!problem) { setReviewStatus('問題文を入力してください。', true); return; }
  if (!blocks.length) { setReviewStatus('見直す式をノートに入力してください。', true); return; }
  reviewSubmitting = true;
  const submit = document.getElementById('review-submit'); if (submit) submit.disabled = true;
  setReviewStatus('ノートを保存してから見直しています…');
  try {
    saveCurrentNoteNow();
    const queue = queueForAccount(cloudAccount.userId);
    await drainCloudQueue(queue, cloudAccount.epoch);
    const note = notesStore.notes.find((entry) => entry.id === notesStore.activeId);
    const noteUpdatedAt = note?._cloudUpdatedAt || note?.updatedAt;
    if (!note?.id || !noteUpdatedAt || queue.dirty.size) throw new Error('note_not_saved');
    const result = await apiJson('/reviews', { method: 'POST', body: JSON.stringify({
      noteId: note.id, noteUpdatedAt, problem,
      conditions: document.getElementById('review-conditions')?.value?.trim() || '',
      reviewKind: document.getElementById('review-kind')?.value || 'hint',
      mode: document.getElementById('review-mode')?.value || 'pipeline',
      blocks, idempotencyKey: `review-${crypto.randomUUID()}`,
    }) });
    renderReviewResult(result);
    reviewHistory = [{ ...result, result }, ...reviewHistory.filter((entry) => entry.runId !== result.runId)].slice(0, 6);
    reviewHistoryNoteId = note.id;
    renderReviewHistory();
  } catch (error) {
    const code = error?.payload?.error || error?.message;
    const message = code === 'review_not_configured' ? 'AI見直しはまだ設定されていません。' : code === 'note_stale' ? 'ノートが更新されたため、もう一度見直してください。' : code === 'note_not_saved' ? 'ノートを保存できませんでした。通信を確認してください。' : '見直しを完了できませんでした。';
    setReviewStatus(message, true);
  } finally {
    reviewSubmitting = false;
    if (submit) submit.disabled = false;
  }
}

async function conversionProfileIdempotencyKey(profile) {
  const bytes = new TextEncoder().encode(JSON.stringify(profile));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `profile-${Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function renderConversionProfileAfterLoad() {
  for (const row of rows) if (row.conversion) renderConversionCandidates(row);
  renderConversionPriorityControls();
  if (!document.getElementById('sidebar')?.hidden) renderSidebar();
  // ログイン・ログアウトでアカウント別の辞書へ切り替わったら、開いていれば表エディタも合わせる。
  dictionaryTablePanel?.refresh();
}

function applyCloudConversionProfile(profile, { preserveLearning = true, clean = true } = {}) {
  conversionDictionary = sanitizeConversionDictionaryState(profile?.dictionary);
  const candidates = activeConversionCandidates();
  conversionManualPriority = sanitizeManualPriorityState(profile?.manual, candidates);
  conversionLearning = sanitizeLearningState(preserveLearning ? conversionLearning : null, candidates);
  conversionProfileRevision = Number.isSafeInteger(profile?.revision) && profile.revision >= 0 ? profile.revision : 0;
  if (clean) {
    conversionProfileDirty = false;
    conversionProfileConflict = false;
  }
  persistConversionLocalProfile();
  renderConversionProfileAfterLoad();
}

function queueConversionProfileSave() {
  if (!cloudAccount.userId) return;
  const userId = cloudAccount.userId;
  const epoch = cloudAccount.epoch;
  clearTimeout(conversionProfileSaveTimer);
  conversionProfileSaveTimer = setTimeout(() => { void saveConversionProfile(userId, epoch); }, 120);
  updateConversionDictionaryStorageStatus('pending');
}

async function saveConversionProfile(userId, epoch) {
  if (cloudAccount.userId !== userId || cloudAccount.epoch !== epoch) return;
  updateConversionDictionaryStorageStatus('saving');
  const profile = { dictionary: structuredClone(conversionDictionary), manual: structuredClone(conversionManualPriority) };
  const mutationGeneration = conversionProfileMutationGeneration;
  try {
    const saved = await apiJson('/conversion-profile', {
      method: 'PUT',
      body: JSON.stringify({ ...profile, revision: conversionProfileRevision, idempotencyKey: await conversionProfileIdempotencyKey({ ...profile, revision: conversionProfileRevision }) }),
    });
    if (cloudAccount.userId !== userId || cloudAccount.epoch !== epoch) return;
    if (saved.profile) {
      if (mutationGeneration === conversionProfileMutationGeneration) {
        applyCloudConversionProfile(saved.profile);
      } else {
        // PUT中に後発編集が入っている。先行snapshotで画面を戻さず、serverが
        // 発行したrevisionだけをbaseとして現在のlocal値をもう一度送る。
        conversionProfileRevision = Number.isSafeInteger(saved.profile.revision) && saved.profile.revision >= 0
          ? saved.profile.revision : conversionProfileRevision;
        conversionProfileDirty = true;
        conversionProfileConflict = false;
        persistConversionLocalProfile();
        queueConversionProfileSave();
      }
    }
    updateCloudStatus('saved');
  } catch (error) {
    if (cloudAccount.userId !== userId || cloudAccount.epoch !== epoch || error?.name === 'AbortError') return;
    // 同じprofileの後発編集は別のPUTとして送られる。先行requestが遅れて409を
    // 返しても、その間に後発snapshotが保存済みなら競合ではない。古い応答で
    // dirty/conflict表示を戻すと、成功済みのローカル値を再送してしまうため無視する。
    if (mutationGeneration !== conversionProfileMutationGeneration) return;
    if (error.status === 409 && error.payload?.profile) {
      // base revisionをremote版へ進めない。進めると次回読込で「同じ版」と誤認して
      // 別端末の更新を上書きできてしまう。未送信ローカル値を残して競合を明示する。
      conversionProfileDirty = true;
      conversionProfileConflict = true;
      persistConversionLocalProfile();
      setConversionDictionaryStatus('他の端末の更新と競合しました。ローカルの辞書は保持しています。CSVを確認してからもう一度反映してください。', true);
    }
    updateCloudStatus(error.status === 401 ? 'error' : 'offline');
  }
  requestAnimationFrame(fitCanvasRowsToViewport);
}

async function loadCloudConversionProfile(userId, claimedProfile, operation) {
  try {
    const remote = await apiJson('/conversion-profile', { signal: operation.signal });
    if (!isCurrentAccountOperation(operation, userId)) return false;
    const profile = remote.profile;
    const remoteRevision = Number.isSafeInteger(profile?.revision) && profile.revision >= 0 ? profile.revision : 0;
    if (conversionProfileDirty) {
      if (remoteRevision === conversionProfileRevision) {
        // オフライン中のCSV反映は、同じbase revisionを確認できたときだけ再送する。
        // learningはlocal-onlyのまま、辞書と手動順位だけがPUT対象になる。
        conversionProfileConflict = false;
        persistConversionLocalProfile(userId);
        queueConversionProfileSave();
      } else {
        // remoteが進んでいたらlocalを上書きせず停止する。利用者には既存の
        // CSV入出力で確認・再反映できる状態を残す。
        conversionProfileConflict = true;
        persistConversionLocalProfile(userId);
        setConversionDictionaryStatus('他の端末の更新と競合しました。ローカルの辞書は保持しています。CSVを確認してからもう一度反映してください。', true);
        updateCloudStatus('error');
      }
    } else if (remoteRevision > 0) {
      applyCloudConversionProfile(profile);
    } else if (claimedProfile) {
      // 通信前にuser scopeへjournal済みのclaim。ここは旧local値との互換経路だけ。
      conversionDictionary = claimedProfile.dictionary;
      conversionManualPriority = claimedProfile.manual;
      conversionLearning = claimedProfile.learning;
      conversionProfileRevision = 0;
      conversionProfileDirty = true;
      persistConversionLocalProfile(userId);
      renderConversionProfileAfterLoad();
      queueConversionProfileSave();
    } else if (conversionProfileCloudHasChanges()) {
      // meta導入前に作られたuser scopeの辞書は未送信として移行する。
      conversionProfileRevision = 0;
      conversionProfileDirty = true;
      persistConversionLocalProfile(userId);
      queueConversionProfileSave();
    } else {
      applyCloudConversionProfile(profile);
    }
    return true;
  } catch (error) {
    if (!isCurrentAccountOperation(operation, userId) || error?.name === 'AbortError') return false;
    // オフライン時はアカウント別cacheのままにし、他人のプロファイルと混ぜない。
    updateCloudStatus('offline');
    return true;
  }
}

function serializableNote(note) {
  const rows = note.rows.map((row) => String(row || ''));
  const layout = normalizeNoteLayout(note.layout, rows);
  return {
    id: note.id,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    unitId: note.unitId,
    rows,
    layout: layout.mode === 'canvas'
      ? layout
      : { mode: 'rows', camera: layout.camera, blocks: [], blockIds: layout.blockIds },
    revision: Number.isSafeInteger(note.revision) ? note.revision : 0,
    // 段階4: 名前・ソフトデリートもクラウドへ送る（0005_note_title_deleted.sqlでサーバに列を追加済み）。
    // サーバ側もクライアントと同じ丸め方（sanitizeNoteTitle/sanitizeNoteDeletedAt相当）で受ける。
    title: sanitizeNoteTitle(note.title),
    deletedAt: sanitizeNoteDeletedAt(note.deletedAt),
  };
}

function validCloudNotes(notes) {
  const encoded = JSON.stringify(notes);
  return notes.length <= CLOUD_NOTE_LIMIT && new TextEncoder().encode(encoded).byteLength <= CLOUD_NOTE_BYTES_LIMIT;
}

function cloudNoteBytes(note) {
  return new TextEncoder().encode(JSON.stringify(note)).byteLength;
}

function splitCloudImport(notes) {
  const sorted = [...notes].sort((left, right) => left.id.localeCompare(right.id));
  const chunks = [];
  let chunk = [];
  let bytes = 2;
  const rejected = [];
  for (const note of sorted) {
    const noteBytes = cloudNoteBytes(note);
    if (noteBytes > CLOUD_NOTE_BYTES_LIMIT) { rejected.push(note); continue; }
    const separator = chunk.length ? 1 : 0;
    if (chunk.length === CLOUD_NOTE_LIMIT || bytes + separator + noteBytes > CLOUD_NOTE_BYTES_LIMIT) {
      chunks.push(chunk);
      chunk = [];
      bytes = 2;
    }
    chunk.push(note);
    bytes += (chunk.length > 1 ? 1 : 0) + noteBytes;
  }
  if (chunk.length) chunks.push(chunk);
  return { chunks, rejected };
}

function mergeCloudNotes(remoteNotes, localNotes) {
  const merged = new Map(remoteNotes.map((note) => [note.id, { ...note, revision: Number(note.revision) || 0 }]));
  for (const local of localNotes) {
    const current = merged.get(local.id);
    const currentRevision = Number(current?.revision) || 0;
    const localRevision = Number(local.revision) || 0;
    const localIsPending = Number.isSafeInteger(local._cloudGeneration);
    if (!current || localIsPending || localRevision > currentRevision || (localRevision === currentRevision && String(local.updatedAt) > String(current.updatedAt))) {
      merged.set(local.id, { ...local });
    }
  }
  return [...merged.values()].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function queueForAccount(userId) {
  let queue = cloudQueues.get(userId);
  if (!queue) {
    queue = { accountId: userId, timer: null, running: false, dirty: new Map() };
    cloudQueues.set(userId, queue);
  }
  return queue;
}

function queueCloudSave(note) {
  if (!cloudAccount.userId || !note || restoringNote) return;
  const queue = queueForAccount(cloudAccount.userId);
  const generation = ++cloudGeneration;
  note._cloudGeneration = generation;
  queue.dirty.set(note.id, generation);
  persistNotesStore();
  clearTimeout(queue.timer);
  queue.timer = setTimeout(() => { void drainCloudQueue(queue, cloudAccount.epoch); }, NOTE_SAVE_DELAY_MS + 160);
  updateCloudStatus('saving');
}

function accountStillOwnsQueue(queue, epoch) {
  return cloudAccount.userId === queue.accountId && cloudAccount.epoch === epoch;
}

async function preserveConflict(queue, noteId, generation) {
  if (!accountStillOwnsQueue(queue, cloudAccount.epoch)) return;
  const local = notesStore.notes.find((entry) => entry.id === noteId);
  if (!local || local._cloudGeneration !== generation) return;
  local.id = `${makeNoteId()}-conflict`;
  local.updatedAt = new Date().toISOString();
  local.revision = 0;
  notesStore.activeId = local.id;
  queue.dirty.delete(noteId);
  persistNotesStore();
  renderNotesList();
  queueCloudSave(local);
}

async function drainCloudQueue(queue, epoch) {
  if (queue.running || !accountStillOwnsQueue(queue, epoch)) return;
  queue.running = true;
  try {
    while (queue.dirty.size && accountStillOwnsQueue(queue, epoch)) {
      const [noteId, generation] = queue.dirty.entries().next().value;
      const note = notesStore.notes.find((entry) => entry.id === noteId);
      if (!note || note._cloudGeneration !== generation || !validCloudNotes([serializableNote(note)])) {
        queue.dirty.delete(noteId);
        continue;
      }
      const snapshot = serializableNote(note);
      updateCloudStatus('saving');
      try {
        const saved = await apiJson(`/notes/${encodeURIComponent(snapshot.id)}`, { method: 'PUT', body: JSON.stringify(snapshot) });
        if (!accountStillOwnsQueue(queue, epoch)) break;
        const current = notesStore.notes.find((entry) => entry.id === snapshot.id);
        if (current && current._cloudGeneration === generation && saved.note) {
          current.revision = saved.note.revision;
          // 見直しはサーバで確定したsnapshotを参照する。表示用updatedAtは既存の
          // 並び順ルールを崩さないため触らず、照合専用の時刻だけを別に保持する。
          current._cloudUpdatedAt = saved.note.updatedAt;
          // updatedAtはサーバの時計で上書きしない。名前変更・削除・復元はローカルで
          // 意図的にupdatedAtを動かさない操作（一覧の並び順を崩さないため）なので、
          // 遅延して届くこの成功応答で並び順を後から変えてしまわないようにする。
          queue.dirty.delete(snapshot.id);
          persistNotesStore();
        }
      } catch (error) {
        if (!accountStillOwnsQueue(queue, epoch)) break;
        if (error.status === 409 && error.payload?.error === 'conflict') {
          await preserveConflict(queue, noteId, generation);
          continue;
        }
        if (error.status === 401) {
          updateCloudStatus('error');
          return;
        }
        updateCloudStatus('offline');
        return;
      }
    }
  } finally {
    queue.running = false;
    if (accountStillOwnsQueue(queue, epoch) && queue.dirty.size) {
      clearTimeout(queue.timer);
      queue.timer = setTimeout(() => { void drainCloudQueue(queue, epoch); }, 1500);
    } else if (accountStillOwnsQueue(queue, epoch)) {
      updateCloudStatus('saved');
    }
  }
}

function replaceEditorWithActiveNote(restoreFocus = true) {
  const initial = notesStore.notes.find((note) => note.id === notesStore.activeId)
    ?? [...notesStore.notes].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (initial) {
    // ストア切替では旧アカウントの表示面を保存対象にしない。先に新しいactiveIdを
    // 確定し、loadNote側の通常の保存も止めてから差し替える。
    notesStore.activeId = initial.id;
    loadNote(initial.id, restoreFocus, false);
  }
  else {
    // ストアの切替直後に新規作成処理を使うと、前アカウントの表示中の式を
    // 新しい名前空間へ保存してしまう。ここでは保存せず空の編集面だけを作る。
    clearRowsForNote();
    noteUnitScope = ALL_UNITS_ID;
    setCurrentUnit(ALL_UNITS_ID, false);
    createRow(false);
    activeRowIndex = rows.length - 1;
  }
}

function refreshEditorWhenAccountDialogCloses(restoreFocus = true) {
  const dialog = document.getElementById('account-dialog');
  if (dialog?.open) {
    pendingEditorRefresh = true;
    return;
  }
  pendingEditorRefresh = false;
  replaceEditorWithActiveNote(restoreFocus);
}

async function importIdempotencyKey(scope, notes) {
  const payload = new TextEncoder().encode(JSON.stringify(notes));
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return `import-${scope}-${Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function importNotesOnce(scope, notes, signal) {
  const { chunks, rejected } = splitCloudImport(notes);
  const result = { complete: rejected.length === 0, rejected, failed: [], succeeded: [] };
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    try {
      await apiJson('/notes/import', { method: 'POST', signal, body: JSON.stringify({ notes: chunk, idempotencyKey: await importIdempotencyKey(`${scope}-${index}`, chunk) }) });
      result.succeeded.push(...chunk.map((note) => note.id));
    } catch (error) {
      result.complete = false;
      result.failed.push({ chunk, error });
    }
  }
  return result;
}

function anonymousNotes() {
  return readRawNotesStore(NOTE_STORAGE_KEY).notes
    .filter((note) => !note.claimOwner && shouldSyncNote(note))
    .map(serializableNote);
}

function claimAnonymousNotes(userId) {
  const anonymous = readRawNotesStore(NOTE_STORAGE_KEY);
  let changed = false;
  for (const note of anonymous.notes) {
    if (!note.claimOwner && shouldSyncNote(note)) {
      note.claimOwner = userId;
      changed = true;
    }
  }
  // ここが所有権ジャーナル。通信より先に永続化するため、途中で閉じても別アカウントへ渡らない。
  if (changed) persistRawNotesStore(NOTE_STORAGE_KEY, anonymous);
  return anonymous.notes
    .filter((note) => note.claimOwner === userId && shouldSyncNote(note))
    .map(serializableNote);
}

function retireAnonymousClaims(userId, succeededIds) {
  if (!succeededIds.length) return;
  const succeeded = new Set(succeededIds);
  const anonymous = readRawNotesStore(NOTE_STORAGE_KEY);
  const remaining = anonymous.notes.filter((note) => !(note.claimOwner === userId && succeeded.has(note.id)));
  if (remaining.length === anonymous.notes.length) return;
  anonymous.notes = remaining;
  if (!anonymous.notes.some((note) => note.id === anonymous.activeId)) anonymous.activeId = null;
  persistRawNotesStore(NOTE_STORAGE_KEY, anonymous);
}

function retireCloudAccount() {
  const previous = cloudAccount.userId;
  if (previous) {
    const queue = cloudQueues.get(previous);
    if (queue?.timer) clearTimeout(queue.timer);
  }
  // 辞書の遅延保存もアカウントの世代に属する。ここで消さないと、A の
  // タイマーがログアウト後に発火し、たまたま選ばれた B の状態を読む余地が残る。
  clearTimeout(conversionProfileSaveTimer);
  conversionProfileSaveTimer = null;
  cloudAccount.epoch += 1;
}

async function switchToUserStore(userId, importAnonymous = false, operation = beginAccountOperation()) {
  if (!isCurrentAccountOperation(operation)) return false;
  saveCurrentNoteNow();
  retireCloudAccount();
  cloudAccount.userId = userId;
  // 前回このアカウントで「完全に削除」がサーバへ届かず終わっていたら、
  // ログイン（再ログイン・セッション復元）のタイミングで自動的に追いつかせる。
  void drainPendingDeletes(userId);
  updateConversionDictionaryStorageStatus('loading');
  // 辞書・手動順位・学習はノートと同じくアカウント単位で読み直す。切替前の
  // メモリを使い続けないことで、A→B→A でも候補の並びを混ぜない。
  readConversionLocalProfile(userId);
  const claimedConversionProfile = importAnonymous ? claimAnonymousConversionProfile(userId) : null;
  if (claimedConversionProfile && conversionProfileRevision === 0 && !conversionProfileCloudHasChanges()) {
    // 先にaccount scopeへ書く。接続確認が失敗しても、匿名辞書のclaimが次回の
    // login/reloadで消えないための小さなjournalとして扱う。
    conversionDictionary = claimedConversionProfile.dictionary;
    conversionManualPriority = claimedConversionProfile.manual;
    conversionLearning = claimedConversionProfile.learning;
    conversionProfileDirty = true;
    conversionProfileConflict = false;
    persistConversionLocalProfile(userId);
  }
  renderConversionProfileAfterLoad();
  notesStore = { version: NOTE_STORE_VERSION, activeId: null, notes: [] };
  readNotesStore();
  const claimed = importAnonymous ? claimAnonymousNotes(userId) : [];
  if (!isCurrentAccountOperation(operation, userId)) return false;
  // 辞書同期の失敗はノートのログインを失敗扱いにしない。アカウント別の端末
  // キャッシュを残したまま、通信復帰時にだけ再送する。
  await loadCloudConversionProfile(userId, claimedConversionProfile, operation);
  if (!isCurrentAccountOperation(operation, userId)) return false;
  if (claimed.length) {
    notesStore.notes = mergeCloudNotes([], [...notesStore.notes.map(serializableNote), ...claimed]);
    // dialogを閉じるまで編集面の差替えを待つ場合でも、再読込時の保存先は
    // 必ずclaim済みノートにする。activeId が空のままだと beforeunload が
    // 表示中の匿名ノートを別IDで複製してしまう。
    if (!notesStore.activeId) notesStore.activeId = notesStore.notes[0]?.id || null;
    persistNotesStore();
  }
  const cached = notesStore.notes.map(serializableNote).filter(shouldSyncNote);
  const remote = await apiJson('/notes', { signal: operation.signal });
  if (!isCurrentAccountOperation(operation, userId)) return false;
  const remoteNotes = Array.isArray(remote.notes) ? remote.notes.map((note) => ({ ...note, revision: Number(note.revision) || 0 })) : [];
  const cachedImport = await importNotesOnce(`cache-${userId}`, cached, operation.signal);
  if (!isCurrentAccountOperation(operation, userId)) return false;
  const refreshed = await apiJson('/notes', { signal: operation.signal });
  if (!isCurrentAccountOperation(operation, userId)) return false;
  const refreshedNotes = Array.isArray(refreshed.notes) ? refreshed.notes : remoteNotes;
  // import の 2xx は必要条件に留め、直後の読戻しで実在を確認できた分だけ
  // 匿名ジャーナルから退避する。応答後の再読込や一時的な D1 遅延でも、
  // 未確認の claim を失わず同じアカウントだけが再開できる。
  if (importAnonymous) {
    const confirmed = new Set(refreshedNotes.map((note) => note.id));
    retireAnonymousClaims(userId, cachedImport.succeeded.filter((id) => claimed.some((note) => note.id === id) && confirmed.has(id)));
  }
  // 失敗・100件超・オフラインのどの場合も、クラウドに出せなかったローカルを置換で捨てない。
  const localSurvivors = cached;
  notesStore = { version: NOTE_STORE_VERSION, activeId: remote.activeId || notesStore.activeId, notes: mergeCloudNotes(refreshedNotes, localSurvivors) };
  persistNotesStore();
  refreshEditorWhenAccountDialogCloses();
  renderNotesList();
  const failures = [...cachedImport.rejected, ...cachedImport.failed];
  if (failures.length) {
    const capped = failures.some((item) => item?.error?.status === 409 || item?.error?.payload?.error === 'note_limit');
    updateCloudStatus(capped ? 'limit' : 'error');
  } else updateCloudStatus('saved');
  // 見直しから来たログインだけは、認証後に元のモーダルへ戻す。問題文などは
  // review-dialogのDOMに残しているため、ここで入力を作り直したり自動実行したりしない。
  if (reviewResumeAfterLogin) document.getElementById('account-dialog')?.close();
  return true;
}

async function switchToAnonymousStore(operation = beginAccountOperation()) {
  if (!isCurrentAccountOperation(operation)) return false;
  saveCurrentNoteNow();
  retireCloudAccount();
  cloudAccount.userId = null;
  updateConversionDictionaryStorageStatus('local');
  readConversionLocalProfile(null);
  renderConversionProfileAfterLoad();
  notesStore = { version: NOTE_STORE_VERSION, activeId: null, notes: [] };
  readNotesStore();
  refreshEditorWhenAccountDialogCloses();
  renderNotesList();
  updateCloudStatus('local');
  renderAccountDialog();
  return true;
}

function renderAccountDialog(panel) {
  activeAccountPanel = panel || activeAccountPanel || 'login';
  const signedIn = Boolean(cloudAccount.userId);
  document.getElementById('account-signed-in').hidden = !signedIn;
  document.querySelectorAll('.account-panel').forEach((el) => { el.hidden = signedIn || el.dataset.panel !== activeAccountPanel; });
  document.querySelectorAll('.account-tab').forEach((tab) => {
    const selected = !signedIn && tab.dataset.accountPanel === activeAccountPanel;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.hidden = signedIn;
  });
  document.getElementById('account-user-id').textContent = cloudAccount.userId || '';
  updateCloudStatus();
}

function openAccountDialog(panel = 'login') {
  const dialog = document.getElementById('account-dialog');
  setAccountMessage();
  document.getElementById('recovery-code-panel').hidden = true;
  renderAccountDialog(panel);
  if (!dialog.open) dialog.showModal();
  if (panel === 'login' && document.querySelector('meta[name="shikitype-cloud"]')) void prepareGoogleLogin();
}

function hideGoogleLogin() {
  document.getElementById('google-login-panel')?.setAttribute('hidden', '');
  document.getElementById('google-link-submit')?.setAttribute('hidden', '');
}

function loadGoogleIdentityScript() {
  if (window.google?.accounts?.id) return Promise.resolve();
  const existing = document.querySelector('script[data-google-identity]');
  if (existing) return new Promise((resolve, reject) => {
    existing.addEventListener('load', resolve, { once: true });
    existing.addEventListener('error', reject, { once: true });
  });
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.dataset.googleIdentity = 'true';
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', reject, { once: true });
    document.head.append(script);
  });
}

async function completeGoogleLogin(credential) {
  if (!credential || !googleAuth.csrfToken || accountSubmitting) return;
  const operation = beginAccountOperation();
  setAccountSubmitting(true);
  setAccountMessage(googleAuth.intent === 'link' ? 'Googleアカウントを連携しています…' : 'Googleアカウントを確認しています…');
  try {
    const data = await apiJson('/auth/google', {
      method: 'POST', signal: operation.signal,
      headers: { 'X-Shikitype-CSRF': googleAuth.csrfToken },
      body: JSON.stringify({ credential, csrfToken: googleAuth.csrfToken, intent: googleAuth.intent }),
    });
    if (!isCurrentAccountOperation(operation)) return;
    if (googleAuth.intent === 'link') {
      setAccountMessage('Googleアカウントを連携しました。');
      renderAccountDialog();
      return;
    }
    const switched = await switchToUserStore(data.user.id, true, operation);
    if (!switched || !isCurrentAccountOperation(operation, data.user.id)) return;
    setAccountMessage('Googleでログインしました。');
    renderAccountDialog();
  } catch (error) {
    if (!isCurrentAccountOperation(operation) || error?.name === 'AbortError') return;
    if (error.status === 503 || error.payload?.error === 'google_not_configured') hideGoogleLogin();
    setAccountMessage('Googleでのログインに失敗しました。IDとパスワードでもログインできます。', true);
  } finally {
    if (isCurrentAccountOperation(operation)) setAccountSubmitting(false);
    googleAuth.intent = 'login';
  }
}

async function prepareGoogleLogin() {
  if (googleAuth.loading) return googleAuth.loading;
  googleAuth.loading = (async () => {
    try {
      const config = await apiJson('/auth/config');
      if (!config.googleClientId || !config.csrfToken) { hideGoogleLogin(); return; }
      await loadGoogleIdentityScript();
      if (!window.google?.accounts?.id) { hideGoogleLogin(); return; }
      googleAuth.clientId = config.googleClientId;
      googleAuth.csrfToken = config.csrfToken;
      window.google.accounts.id.initialize({ client_id: config.googleClientId, callback: ({ credential }) => void completeGoogleLogin(credential), auto_select: false, cancel_on_tap_outside: true });
      const mount = document.getElementById('google-login');
      if (mount) {
        mount.replaceChildren();
        window.google.accounts.id.renderButton(mount, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: Math.min(340, Math.max(220, mount.parentElement?.clientWidth - 4 || 300)) });
      }
      document.getElementById('google-login-panel')?.removeAttribute('hidden');
      document.getElementById('google-link-submit')?.removeAttribute('hidden');
    } catch {
      hideGoogleLogin();
    } finally {
      googleAuth.loading = null;
    }
  })();
  return googleAuth.loading;
}

async function submitAccount(action) {
  if (accountSubmitting) return;
  const ids = {
    login: ['login-id', 'login-password'], signup: ['signup-id', 'signup-password'], recover: ['recover-id', 'recover-code', 'recover-password'],
  }[action];
  const inputs = ids.map((id) => document.getElementById(id));
  if (!inputs.every((input) => input.checkValidity())) { inputs.find((input) => !input.checkValidity())?.reportValidity(); return; }
  const values = inputs.map((input, index) => index === 0 ? input.value.trim() : input.value);
  if (!values.every(Boolean)) { setAccountMessage('すべて入力してください。', true); return; }
  const [loginId, secret, nextPassword] = values;
  const operation = beginAccountOperation();
  setAccountSubmitting(true);
  setAccountMessage('確認しています…');
  try {
    const body = action === 'login' ? { loginId, password: secret }
      : action === 'signup' ? { loginId, password: secret }
        : { loginId, recoveryCode: secret, newPassword: nextPassword };
    const data = await apiJson(`/auth/${action === 'recover' ? 'recover' : action}`, { method: 'POST', signal: operation.signal, body: JSON.stringify(body) });
    if (!isCurrentAccountOperation(operation)) return;
    if ((action === 'signup' || action === 'recover') && data.recoveryCode) {
      document.getElementById('recovery-code').textContent = data.recoveryCode;
      document.getElementById('recovery-code-panel').hidden = false;
    }
    const switched = await switchToUserStore(data.user.id, true, operation);
    if (!switched || !isCurrentAccountOperation(operation, data.user.id)) return;
    setAccountMessage(action === 'recover' ? 'パスワードを再設定しました。' : 'ログインしました。');
    renderAccountDialog();
  } catch (error) {
    if (!isCurrentAccountOperation(operation) || error?.name === 'AbortError') return;
    setAccountMessage(error.status === 429 ? 'しばらく待ってから、もう一度試してください。' : 'IDまたは入力内容を確認してください。', true);
  } finally {
    if (isCurrentAccountOperation(operation)) setAccountSubmitting(false);
  }
}

async function restoreCloudSession() {
  const operation = beginAccountOperation();
  try {
    const data = await apiJson('/auth/me', { signal: operation.signal });
    if (!isCurrentAccountOperation(operation)) return;
    if (data.user?.id) {
      const switched = await switchToUserStore(data.user.id, true, operation);
      // セッション復元はダイアログを開かないため、通常のログイン経路で行う
      // 描画をここでも明示する。保存先は切り替わっていても表示だけ匿名のまま、
      // というreload直後の不整合を残さない。
      if (switched && isCurrentAccountOperation(operation, data.user.id)) renderAccountDialog();
    }
  } catch {
    if (isCurrentAccountOperation(operation)) updateCloudStatus('local');
  }
}

document.getElementById('account-toggle')?.addEventListener('click', () => openAccountDialog());
document.getElementById('review-toggle')?.addEventListener('click', openReviewDialog);
document.getElementById('review-dialog-shell')?.addEventListener('submit', (event) => { event.preventDefault(); void submitReview(); });
document.getElementById('review-dialog-close')?.addEventListener('click', () => document.getElementById('review-dialog')?.close());
document.getElementById('review-again')?.addEventListener('click', () => openReviewDialog());
document.getElementById('review-login')?.addEventListener('click', () => {
  reviewResumeAfterLogin = true;
  document.getElementById('review-dialog')?.close();
  openAccountDialog('login');
});
document.getElementById('review-dialog')?.addEventListener('keydown', (event) => {
  const dialog = event.currentTarget;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); dialog.close();
    return;
  }
  if (event.key !== 'Tab') { event.stopPropagation(); return; }
  const focusables = [...dialog.querySelectorAll('button:not([disabled]):not([hidden]), textarea:not([disabled]), select:not([disabled]), summary')]
    .filter((item) => item instanceof HTMLElement && !item.closest('[hidden]'));
  if (!focusables.length) return;
  const current = document.activeElement;
  const index = focusables.indexOf(current);
  if (event.shiftKey && (index <= 0 || current === dialog)) { event.preventDefault(); focusables.at(-1)?.focus(); }
  else if (!event.shiftKey && index === focusables.length - 1) { event.preventDefault(); focusables[0]?.focus(); }
  event.stopPropagation();
}, true);
document.getElementById('review-dialog')?.addEventListener('close', () => setTimeout(() => focusActiveRow(), 0));
document.querySelectorAll('.account-tab').forEach((tab) => tab.addEventListener('click', () => renderAccountDialog(tab.dataset.accountPanel)));
document.getElementById('account-tabs')?.addEventListener('keydown', (event) => {
  const tabs = [...document.querySelectorAll('.account-tab:not([hidden])')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  let next = -1;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = tabs.length - 1;
  if (next < 0) return;
  event.preventDefault();
  const tab = tabs[next];
  renderAccountDialog(tab.dataset.accountPanel);
  tab.focus();
});
document.getElementById('account-dialog-shell')?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!cloudAccount.userId) void submitAccount(activeAccountPanel);
});
document.getElementById('account-dialog')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // MathLiveの全体キー処理へEscが流れる前に、dialogの標準的な閉じ方を確定する。
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.close();
});
document.querySelector('.account-close')?.addEventListener('click', () => document.getElementById('account-dialog')?.close());
document.getElementById('account-dialog')?.addEventListener('close', () => {
  // Esc/×/ログイン後/ログアウト後の全経路で、450ms以内に数式入力へ戻す。
  if (pendingEditorRefresh) refreshEditorWhenAccountDialogCloses(false);
  clearTimeout(restoreFocusTimer);
  restoreFocusTimer = setTimeout(() => focusAfterAccountDialogClose(), 0);
  if (reviewResumeAfterLogin && cloudAccount.userId) {
    reviewResumeAfterLogin = false;
    setTimeout(() => openReviewDialog({ focusProblem: false }), 0);
  }
});
document.getElementById('recovery-code-done')?.addEventListener('click', () => { document.getElementById('recovery-code-panel').hidden = true; });
document.getElementById('logout-submit')?.addEventListener('click', async () => {
  if (accountSubmitting) return;
  const operation = beginAccountOperation();
  setAccountSubmitting(true);
  try { await apiJson('/auth/logout', { method: 'POST', signal: operation.signal, body: '{}' }); } catch { /* 接続不能でも端末側は切り替える */ }
  if (isCurrentAccountOperation(operation)) {
    await switchToAnonymousStore(operation);
    document.getElementById('account-dialog').close();
    setAccountSubmitting(false);
  }
});
document.getElementById('google-link-submit')?.addEventListener('click', async () => {
  await prepareGoogleLogin();
  if (!googleAuth.clientId || !window.google?.accounts?.id) return;
  googleAuth.intent = 'link';
  window.google.accounts.id.prompt();
});

setInputMethod(inputMethod, false);
setKeyCaptureMode(keyCaptureMode, false);
updateCourseLabel();
renderPalette();
installCanvasControls();
renderLayoutMode();
createRow(true);
readNotesStore();
const initialNote = notesStore.notes.find((note) => note.id === notesStore.activeId)
  ?? [...notesStore.notes].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
if (initialNote) loadNote(initialNote.id, true, false);
else initHistory(); // loadNote()は内部でinitHistory()するが、保存済みノートが無い初回起動はここで初期化する
setInputSystem(inputSystem, false);
renderNotesList();
renderBreadcrumb();
if (document.querySelector('meta[name="shikitype-cloud"]')) void restoreCloudSession();

window.__neoApp = {
  rows,
  getActiveRow: activeRow,
  // E2E回帰の診断用。表示や入力状態を変えず、focus rAFとの競合を行単位で読める。
  getInputDebugState: () => ({
    activeRowIndex,
    activeRowId: activeRow()?.id ?? null,
    focusedRowId: rows.find((row) => document.activeElement === row.mf || row.mf.contains?.(document.activeElement))?.id ?? null,
    rows: rows.map((row) => ({
      id: row.id,
      nativeTextOpen: row.nativeTextOpen,
      stack: row.stack.map((frame) => frame.kind),
      mode: row.mf.mode,
      value: row.mf.value,
      position: row.mf.position,
    })),
  }),
  dispatchAction,
  getActiveLayout,
  stats,
  applyTheme,
  getTheme: () => document.body.dataset.theme,
  getBaseLayer: () => activeInputLayer(),
  getLockedLayer: () => baseLayer,
  cycleBaseLayer,
  setInputMethod,
  setInputSystem,
  getInputSystem: () => inputSystem,
  setLayoutMode,
  getLayoutMode: () => layoutMode,
  getCanvasCamera: () => ({ ...canvasCamera }),
  getCanvasBlocks: () => noteLayoutSnapshot().blocks,
  getInputMethod: () => inputMethod,
  setThemeRailCollapsed: applyThemeRailCollapsed,
  isThemeRailCollapsed: () => document.body.classList.contains('theme-rail-collapsed'),
  setKeyCaptureMode,
  getKeyCaptureMode: () => keyCaptureMode,
  handleVirtualKey,
  handleVirtualSpecial,
  getCurrentUnit: () => currentUnit,
  getNoteUnitScope: () => noteUnitScope,
  getCurrentSubject: () => currentSubject,
  setCurrentUnit,
  setNoteUnitScope,
  setCurrentSubject,
  getMethodBaseLayer: () => ({ ...methodBaseLayer }),
  setMethodBaseLayer,
  getLayerInputMethods: () => ({ ...layerInputMethods }),
  setLayerInputMethod,
  openConversion: () => openConversion(activeRow(), false),
  closeConversion: () => closeConversion(activeRow(), { clear: true, focus: false }),
  getConversionState: () => {
    const state = activeRow()?.conversion;
    return state ? {
      open: conversionOpen && !state.shell.hidden,
      query: state.preview.textContent,
      raw: state.raw,
      reading: state.reading,
      searchReading: state.searchReading,
      pending: state.pending,
      composing: state.composing,
      navigation: state.navigation,
      selectedIndex: state.selectedIndex,
      candidates: state.candidates.map((candidate) => candidate.id),
    } : null;
  },
  getConversionPreferences: () => ({ learning: structuredClone(conversionLearning), manual: structuredClone(conversionManualPriority) }),
  setConversionManualPriority: (candidateId, priority) => {
    conversionManualPriority = setManualPriority(conversionManualPriority, candidateId, priority, activeConversionCandidates());
    saveConversionPreferences({ profileChange: true });
    queueConversionProfileSave();
    renderConversionPriorityControls();
  },
  resetConversionManualPriorities: () => {
    conversionManualPriority = resetManualPriorities();
    saveConversionPreferences({ profileChange: true });
    queueConversionProfileSave();
    renderConversionPriorityControls();
  },
  getConversionDictionary: () => structuredClone(conversionDictionary),
  getEffectiveConversionCandidates: () => structuredClone(activeConversionCandidates()),
  importConversionDictionaryText: (text, mode = 'merge') => {
    const result = importConversionDictionaryCsv(text, conversionDictionary, { mode });
    if (result.accepted) {
      applyConversionDictionary(result.state);
      queueConversionProfileSave();
    }
    return result;
  },
  exportConversionDictionaryCsv: () => exportConversionDictionaryCsv(conversionDictionary),
  saveNote: saveCurrentNoteNow,
  // UIは単元選択モーダルを経由する。既存の回帰テスト用APIは、従来どおり
  // 即時に全単元の白紙を作る低レベル操作として残す。
  newNote: () => createNewNote(ALL_UNITS_ID),
  createNewNote,
  openNewNoteDialog,
  loadNote,
  getNotes: () => structuredClone(notesStore),
  undo: performUndo,
  redo: performRedo,
  getHistoryState: () => ({ index: historyIndex, length: historyStack.length, dirty: historyDirty }),
  // 段階2（矩形選択・ブロックdrag・ブロックコピー貼り付け）のE2E回帰用。
  getSelectedRowIds: () => [...selectedRows].map((row) => row.id),
  getBlockClipboard: () => (blockClipboard ? structuredClone(blockClipboard) : null),
};
