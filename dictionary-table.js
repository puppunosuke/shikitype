// SHIKITYPE 読み辞書エディタ（設定モーダル組み込み版）
//
// tools/reading-dictionary-csv-editor.html（単体HTML）の行編集エンジンを土台にしている。
// 単体HTMLは file:// で直接開かれるため type="module" にできず、ロジックをこちらへ
// import させることができない（相対importはfile://ではCORSで失敗する）。そのため単体HTML側の
// <script>は一切変更せず、同じ検証ルール・同じ操作感（スクロール/検索/フォーカスを保つ削除、
// 読みを空にした複製行の直下挿入）をこのモジュールへ移植して、設定モーダル向けに再構成した。
// 単体HTMLは今までどおり動く（このファイルからは参照されない）。

import {
  CONVERSION_DICTIONARY_LIMITS,
  exportConversionDictionaryCsv,
  importConversionDictionaryCsv,
  normalizeConversionQuery,
} from './conversion.js';

const FIELDS = ['operation', 'candidate_id', 'symbol', 'latex', 'reading', 'base_priority'];
const PAGE_SIZE = 60;
const candidateIdPattern = /^[a-z][a-z0-9-]{1,63}$/;
// tools/reading-dictionary-csv-editor.html・conversion.js・cloud/src/index.tsと同じ安全域。
const safeLatexPattern = /^[A-Za-z0-9\\{}[\]()_^+\-*/=<>|.,:;!?#% \t]+$/;
const unsafeLatexCommand = /\\(?:html[a-z]*|class|style|href|url|includegraphics)\b/i;

function hasControlChar(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
const cleanText = (value, max) => {
  const text = String(value ?? '').normalize('NFKC').trim();
  return text && text.length <= max && !hasControlChar(text) ? text : null;
};
const cleanLatex = (value) => {
  const text = String(value ?? '').trim();
  return text && text.length <= CONVERSION_DICTIONARY_LIMITS.maxLatexLength && safeLatexPattern.test(text) && !unsafeLatexCommand.test(text) ? text : null;
};
const cleanPriority = (value) => {
  const number = Number(String(value ?? '').trim());
  return Number.isInteger(number) && number >= CONVERSION_DICTIONARY_LIMITS.minPriority && number <= CONVERSION_DICTIONARY_LIMITS.maxPriority ? number : null;
};
const normalizeOperation = (value) => {
  const text = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  if (['upsert', 'add', 'update', '追加', '更新'].includes(text)) return 'upsert';
  if (['delete', 'remove', '削除', '無効化'].includes(text)) return 'delete';
  return null;
};
const makeKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

function freshRow() {
  return { key: makeKey(), operation: 'upsert', candidate_id: '', symbol: '', latex: '', reading: '', base_priority: '0' };
}

function rowErrors(row) {
  const errors = {};
  const operation = normalizeOperation(row.operation);
  if (!operation) errors.operation = 'upsert または delete を選んでください';
  const id = String(row.candidate_id ?? '').trim().toLowerCase();
  if (!candidateIdPattern.test(id)) errors.candidate_id = '英小文字で始まる2〜64文字（英数字とハイフン）にしてください';
  if (operation === 'upsert') {
    if (!cleanText(row.symbol, CONVERSION_DICTIONARY_LIMITS.maxLabelLength)) errors.symbol = `記号は1〜${CONVERSION_DICTIONARY_LIMITS.maxLabelLength}文字、改行なしにしてください`;
    if (!cleanLatex(row.latex)) errors.latex = `数式は1〜${CONVERSION_DICTIONARY_LIMITS.maxLatexLength}文字。安全でない命令や改行は使えません`;
    if (!cleanText(row.reading, CONVERSION_DICTIONARY_LIMITS.maxReadingLength)) errors.reading = `読みは1〜${CONVERSION_DICTIONARY_LIMITS.maxReadingLength}文字、改行なしにしてください`;
    if (cleanPriority(row.base_priority) === null) errors.base_priority = `${CONVERSION_DICTIONARY_LIMITS.minPriority}〜${CONVERSION_DICTIONARY_LIMITS.maxPriority}の整数にしてください`;
  }
  return errors;
}

// 同じcandidate_idのupsertは定義（symbol・latex・base_priority）を全行で揃える。読みだけ複数行にできる。
function validateRows(rows) {
  const errors = rows.map(rowErrors);
  const definitions = new Map();
  rows.forEach((row, index) => {
    if (normalizeOperation(row.operation) !== 'upsert' || !candidateIdPattern.test(String(row.candidate_id ?? '').trim().toLowerCase())) return;
    const symbol = cleanText(row.symbol, CONVERSION_DICTIONARY_LIMITS.maxLabelLength);
    const latex = cleanLatex(row.latex);
    const priority = cleanPriority(row.base_priority);
    if (!symbol || !latex || priority === null) return;
    const id = String(row.candidate_id).trim().toLowerCase();
    const definition = JSON.stringify([symbol, latex, priority]);
    const group = definitions.get(id) ?? [];
    group.push({ index, definition });
    definitions.set(id, group);
  });
  for (const group of definitions.values()) {
    if (new Set(group.map((item) => item.definition)).size < 2) continue;
    for (const { index } of group) {
      const message = '同じcandidate_idのsymbol・latex・base_priorityは全行で一致させてください';
      errors[index].symbol = message; errors[index].latex = message; errors[index].base_priority = message;
    }
  }
  return errors;
}

function filterIndexes(rows, query) {
  const normalizedQuery = normalizeConversionQuery(query);
  if (!normalizedQuery) return rows.map((_, index) => index);
  return rows.flatMap((row, index) => FIELDS.map((field) => row[field]).some((value) => normalizeConversionQuery(String(value ?? '')).includes(normalizedQuery)) ? [index] : []);
}

function cloneForReading(row) {
  return { ...row, key: makeKey(), reading: '' };
}

function clampScrollPosition(position, scrollSize, viewportSize) {
  return Math.max(0, Math.min(position, Math.max(0, scrollSize - viewportSize)));
}

// CSVの1行 = version,operation,candidate_id,symbol,latex,reading,base_priority を、
// このエディタの行モデル（version固定・operationはUI項目）へ変換する。
function csvTextToRows(csvText) {
  const parsed = exportedCsvToRecords(csvText);
  return parsed.map((cells) => ({
    key: makeKey(),
    operation: normalizeOperation(cells.operation) ?? 'upsert',
    candidate_id: String(cells.candidate_id ?? '').trim().toLowerCase(),
    symbol: String(cells.symbol ?? '').trim(),
    latex: String(cells.latex ?? '').trim(),
    reading: String(cells.reading ?? '').trim(),
    base_priority: String(cells.base_priority ?? '').trim(),
  }));
}

// exportConversionDictionaryCsv()は既に安全な形（BOM・CRLF・引用符）で返すため、
// ここではその形を素朴にパースするだけでよい（conversion.js自身のCSVを読み戻すだけ）。
function exportedCsvToRecords(csvText) {
  const rows = [];
  const source = String(csvText ?? '').replace(/^﻿/, '');
  let row = []; let cell = ''; let quoted = false;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { pushCell(); if (row.some((value) => value !== '')) rows.push(row); row = []; };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') { if (source[index + 1] === '"') { cell += '"'; index += 1; } else quoted = false; }
      else cell += char;
      continue;
    }
    if (char === '"' && !cell) quoted = true;
    else if (char === ',') pushCell();
    else if (char === '\r') { /* ignore, \n終端で行を確定 */ }
    else if (char === '\n') pushRow();
    else cell += char;
  }
  if (cell || row.length) pushRow();
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
}

function rowsToCsvText(rows) {
  const csvCell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['version', 'operation', 'candidate_id', 'symbol', 'latex', 'reading', 'base_priority'];
  const body = rows.map((row) => [1, row.operation, row.candidate_id, row.symbol, row.latex, row.reading, row.base_priority]);
  return `﻿${[header, ...body].map((record) => record.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * 設定モーダルの「変換」カテゴリ内に、読み辞書のインライン編集テーブルを組み込む。
 * root配下へDOMを一度だけ構築し、以後は state.refresh()/state.destroy() で制御する。
 */
export function createDictionaryTablePanel(root, { getDictionary, applyReplace, onStatus }) {
  root.innerHTML = `
    <div class="dictionary-editor-toolbar">
      <input type="search" class="dictionary-editor-search" placeholder="読み・記号・候補IDを検索" aria-label="表の行を検索" autocomplete="off">
      <span class="dictionary-editor-summary"></span>
      <button type="button" class="dictionary-editor-add">行を追加</button>
    </div>
    <div class="dictionary-editor-grid">
      <div class="dictionary-editor-table-wrap">
        <table>
          <!-- 数式・読みを%指定にすると、table-layout:fixedの表がwrap幅より狭い場合
               （例: 360px幅ではwrap自体が約180px）、固定px列(64+120+72+64=320px)の合計だけで
               表の全幅が決まってしまい、%列に残る幅が0になって入力欄が実測10px（事実上見えず
               操作不能）まで潰れる事故を実測で確認した。全列を固定pxにし、コンテナが狭いときは
               wrapの横スクロールへ委ねる（列を潰さず、常に打てる最小幅を保証する）。 -->
          <colgroup><col style="width:64px"><col style="width:120px"><col style="width:72px"><col style="width:180px"><col style="width:140px"><col style="width:64px"></colgroup>
          <thead><tr><th>操作</th><th>候補ID</th><th>記号</th><th>数式</th><th>読み</th><th>優先度</th></tr></thead>
          <tbody></tbody>
        </table>
        <p class="dictionary-editor-empty" hidden>行がありません。「行を追加」から始めてください。</p>
      </div>
      <aside class="dictionary-editor-rail" aria-label="行ごとの操作">
        <div class="dictionary-editor-rail-body"></div>
      </aside>
    </div>
    <nav class="dictionary-editor-pager"><button type="button" class="dictionary-editor-prev">前へ</button><span class="dictionary-editor-page"></span><button type="button" class="dictionary-editor-next">次へ</button></nav>
    <div class="dictionary-editor-actions">
      <button type="button" class="dictionary-editor-apply">この表の内容を保存</button>
      <button type="button" class="dictionary-editor-revert">未保存の変更を破棄</button>
    </div>
  `;
  const els = {
    search: root.querySelector('.dictionary-editor-search'),
    summary: root.querySelector('.dictionary-editor-summary'),
    add: root.querySelector('.dictionary-editor-add'),
    tableWrap: root.querySelector('.dictionary-editor-table-wrap'),
    rows: root.querySelector('tbody'),
    empty: root.querySelector('.dictionary-editor-empty'),
    rail: root.querySelector('.dictionary-editor-rail'),
    railBody: root.querySelector('.dictionary-editor-rail-body'),
    prev: root.querySelector('.dictionary-editor-prev'),
    next: root.querySelector('.dictionary-editor-next'),
    page: root.querySelector('.dictionary-editor-page'),
    apply: root.querySelector('.dictionary-editor-apply'),
    revert: root.querySelector('.dictionary-editor-revert'),
  };

  let rows = [];
  let baseline = '[]';
  let page = 1;
  let search = '';
  const pinnedVisibleKeys = new Set();

  const canonicalSnapshot = () => JSON.stringify(rows.map(({ key, ...row }) => row));
  const isDirty = () => canonicalSnapshot() !== baseline;

  function loadFromDictionary() {
    rows = csvTextToRows(getDictionary());
    baseline = canonicalSnapshot();
    pinnedVisibleKeys.clear();
    page = 1;
    render();
  }

  function filteredIndexes() {
    const matches = new Set(filterIndexes(rows, search));
    if (!pinnedVisibleKeys.size) return [...matches];
    return rows.flatMap((row, index) => matches.has(index) || pinnedVisibleKeys.has(row.key) ? [index] : []);
  }

  function syncRailHeight() {
    if (!els.rail.hidden) {
      els.rail.style.height = `${els.tableWrap.clientHeight}px`;
      els.railBody.style.transform = `translateY(${-els.tableWrap.scrollTop}px)`;
    }
  }

  function restoreScroll(snapshot) {
    requestAnimationFrame(() => {
      els.tableWrap.scrollTop = clampScrollPosition(snapshot.top, els.tableWrap.scrollHeight, els.tableWrap.clientHeight);
      els.tableWrap.scrollLeft = clampScrollPosition(snapshot.left, els.tableWrap.scrollWidth, els.tableWrap.clientWidth);
      syncRailHeight();
    });
  }

  function focusInsertedReading(key, snapshot) {
    requestAnimationFrame(() => {
      els.tableWrap.scrollTop = clampScrollPosition(snapshot.top, els.tableWrap.scrollHeight, els.tableWrap.clientHeight);
      els.tableWrap.scrollLeft = clampScrollPosition(snapshot.left, els.tableWrap.scrollWidth, els.tableWrap.clientWidth);
      syncRailHeight();
      const control = els.rows.querySelector(`[data-key="${key}"][data-field="reading"]`);
      if (!control) return;
      control.focus({ preventScroll: true });
    });
  }

  function updateSummary() {
    const invalid = validateRows(rows).filter((errors) => Object.keys(errors).length).length;
    const dirty = isDirty();
    els.summary.textContent = `${rows.length}行${invalid ? ` / ${invalid}行に入力エラー` : ''}${dirty ? ' / 未保存の変更あり' : ''}`;
    els.apply.disabled = Boolean(invalid) || !dirty;
    els.revert.disabled = !dirty;
  }

  function render() {
    const indexes = filteredIndexes();
    const totalPages = Math.max(1, Math.ceil(indexes.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const shown = indexes.slice(start, start + PAGE_SIZE);
    const errors = validateRows(rows);
    els.rows.replaceChildren();
    els.railBody.replaceChildren();
    els.empty.hidden = Boolean(rows.length);
    els.rail.hidden = !shown.length;
    for (const index of shown) {
      const row = rows[index];
      const tr = document.createElement('tr');
      for (const field of FIELDS) {
        const td = document.createElement('td');
        const control = field === 'operation' ? document.createElement('select') : document.createElement('input');
        control.className = 'dictionary-editor-input' + (errors[index][field] ? ' is-invalid' : '');
        control.dataset.index = String(index);
        control.dataset.field = field;
        control.dataset.key = row.key;
        control.title = errors[index][field] || '';
        if (field === 'operation') {
          for (const value of ['upsert', 'delete']) {
            const option = document.createElement('option');
            option.value = value; option.textContent = value === 'upsert' ? '登録' : '無効化';
            control.append(option);
          }
          control.value = normalizeOperation(row.operation) ?? 'upsert';
        } else {
          control.type = 'text';
          control.value = row[field] ?? '';
          control.spellcheck = false;
        }
        td.append(control);
        tr.append(td);
      }
      els.rows.append(tr);
      const railRow = document.createElement('div');
      railRow.className = 'dictionary-editor-rail-row';
      const insert = document.createElement('button');
      insert.type = 'button'; insert.className = 'dictionary-editor-rail-btn';
      insert.dataset.insertReading = String(index);
      insert.title = 'この行を直下へコピーし、読みだけを空欄にして追加する';
      insert.textContent = '読み追加';
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'dictionary-editor-rail-btn dictionary-editor-rail-danger';
      remove.dataset.remove = String(index);
      remove.title = '表からこの行を消す（既定の読み・候補を無効化するにはoperation=無効化を使う）';
      remove.textContent = '消す';
      railRow.append(insert, remove);
      els.railBody.append(railRow);
    }
    els.page.textContent = `${page} / ${totalPages}`;
    els.prev.disabled = page <= 1;
    els.next.disabled = page >= totalPages;
    updateSummary();
    requestAnimationFrame(syncRailHeight);
  }

  els.rows.addEventListener('input', (event) => {
    const control = event.target;
    const index = Number(control.dataset.index);
    const field = control.dataset.field;
    if (!Number.isInteger(index) || !field || !rows[index]) return;
    rows[index][field] = control.value;
    // 毎打鍵で表を作り直すとフォーカス・キャレットが消えるため、検証表示だけ更新する。
    const errors = validateRows(rows);
    els.rows.querySelectorAll('.dictionary-editor-input').forEach((el) => {
      const i = Number(el.dataset.index); const f = el.dataset.field;
      const message = errors[i]?.[f] ?? '';
      el.classList.toggle('is-invalid', Boolean(message));
      el.title = message;
    });
    updateSummary();
  });
  els.rows.addEventListener('change', (event) => {
    const control = event.target;
    const index = Number(control.dataset.index);
    const field = control.dataset.field;
    if (!Number.isInteger(index) || !field || !rows[index]) return;
    rows[index][field] = control.value;
    updateSummary();
  });

  els.rail.addEventListener('click', (event) => {
    const insertButton = event.target.closest('[data-insert-reading]');
    if (insertButton) {
      const index = Number(insertButton.dataset.insertReading);
      if (!Number.isInteger(index) || index < 0 || index >= rows.length) return;
      const snapshot = { top: els.tableWrap.scrollTop, left: els.tableWrap.scrollLeft };
      const copy = cloneForReading(rows[index]);
      rows.splice(index + 1, 0, copy);
      pinnedVisibleKeys.add(copy.key);
      const visibleIndex = filteredIndexes().indexOf(index + 1);
      page = visibleIndex >= 0 ? Math.floor(visibleIndex / PAGE_SIZE) + 1 : page;
      render();
      focusInsertedReading(copy.key, snapshot);
      return;
    }
    const removeButton = event.target.closest('[data-remove]');
    if (!removeButton) return;
    const index = Number(removeButton.dataset.remove);
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) return;
    // 一覧が先頭へ飛ばないよう、削除前のスクロール位置を保って復元する。
    const snapshot = { top: els.tableWrap.scrollTop, left: els.tableWrap.scrollLeft };
    pinnedVisibleKeys.delete(rows[index].key);
    rows.splice(index, 1);
    render();
    restoreScroll(snapshot);
  });

  els.tableWrap.addEventListener('scroll', syncRailHeight);
  els.rail.addEventListener('wheel', (event) => { event.preventDefault(); els.tableWrap.scrollTop += event.deltaY; }, { passive: false });
  // ページ・検索の切り替えは「別の行集合を新しく見せる」操作であり、削除・読み追加のような
  // 「同じ行集合内での位置維持」とは意味が違う。旧ページの`scrollTop`を持ち越すと、新ページの
  // 行数がそのオフセットに満たない場合にブラウザが自動クランプし、先頭行（と行操作レール）が
  // 表示領域の外へ隠れて操作できなくなる（実測: page-changeでscrollTopを戻さないと
  // 二重で操作不能に陥ることをPlaywrightで確認）。ページ・検索を変えたら必ず先頭へ戻す。
  function resetScrollToTop() { els.tableWrap.scrollTop = 0; els.tableWrap.scrollLeft = 0; syncRailHeight(); }
  els.search.addEventListener('input', () => { search = els.search.value; pinnedVisibleKeys.clear(); page = 1; render(); resetScrollToTop(); });
  els.prev.addEventListener('click', () => { page -= 1; render(); resetScrollToTop(); });
  els.next.addEventListener('click', () => { page += 1; render(); resetScrollToTop(); });
  els.add.addEventListener('click', () => {
    rows.push(freshRow());
    search = ''; els.search.value = '';
    page = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    render();
    els.rows.querySelector(`[data-index="${rows.length - 1}"][data-field="candidate_id"]`)?.focus();
  });
  els.revert.addEventListener('click', () => { loadFromDictionary(); onStatus?.('未保存の変更を破棄しました。', false); });
  els.apply.addEventListener('click', () => {
    const errors = validateRows(rows);
    if (errors.some((e) => Object.keys(e).length)) { onStatus?.('入力エラーがある行を直してから保存してください。', true); return; }
    const csv = rowsToCsvText(rows);
    const result = applyReplace(csv);
    baseline = canonicalSnapshot();
    updateSummary();
    const rejectedCount = result?.rejected?.length ?? 0;
    onStatus?.(`${result?.accepted ?? rows.length}行を保存しました。${rejectedCount ? `${rejectedCount}行は反映できませんでした。` : ''}`, Boolean(rejectedCount));
    // 保存後の正規化された状態（重複除去・既定候補との統合）を見せるため読み直す。
    loadFromDictionary();
  });

  loadFromDictionary();

  // 設定モーダルは最初「基本」カテゴリを表示しており、この表は「変換」カテゴリへ
  // 切り替えるまで非表示（高さ0）のまま初期化される。requestAnimationFrame一発の
  // 高さ同期だと、非表示中に測った0がそのまま固まり、表示後もスクロールしない限り
  // 削除レール（消す・読み追加）が高さ0でクリックできない事故になる（実測で発見）。
  // ResizeObserverならdisplay:none解除による寸法変化も自動で拾えるため、これに任せる。
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => syncRailHeight()) : null;
  resizeObserver?.observe(els.tableWrap);

  return {
    refresh() { if (!isDirty()) loadFromDictionary(); },
    isDirty,
    destroy() { resizeObserver?.disconnect(); root.innerHTML = ''; },
  };
}
