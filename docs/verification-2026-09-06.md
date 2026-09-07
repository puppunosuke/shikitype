# Canvas・表示担当の受入記録（2026-09-06）

対象はC1-C4、D1、F1だけである。A/B/E/F2/F3の合否はこの記録に含めない。

| 項目 | 受入結果 | 証拠 | 残る確認 |
| --- | --- | --- | --- |
| C1 カーソル | 現行コードで旧事象は再現せず | zoom・pan後も変換カーソルが入力ブロック内: `node tests/canvas-layout-persistence.test.mjs` | Mac実機 |
| C2 ブロック実寸 | 現行コードで旧事象は再現せず | 縦長式の自動配置、900文字の長式: `node tests/structure-canvas-interactions.test.mjs` | Mac実機 |
| C3 ヘッダー切替 | 合格 | ヘッダー操作で行表示へ変更: `node tests/canvas-layout-persistence.test.mjs` | Mac実機 |
| C4 座標保持 | 合格 | canvas→rows→別ノート→canvasで座標、自由配置、cameraを復元。同時に最後のblockを削除したcanvasが0 blockのまま再読込: `node tests/canvas-board.test.mjs` | Mac実機 |
| D1 360px上部操作 | 実装・自動確認済み | 文字ラベルを隠し、上部レールとヘッダーの横幅を確認。単元表示から撤去済みキーガイドの文言も除去: `node tests/canvas-layout-persistence.test.mjs` | 彩葉レビュー、Mac実機 |
| F1 設定余白 | 実装・自動確認済み | 基本タブのダイアログ高が固定760pxでなく、本文下端の余白が80px未満: 同テスト | 1440px実画面、彩葉レビュー |

## 保存形式と旧版互換

本文の正本は`rows`である。行表示で保存する`layout.blocks`は座標・自由配置・IDだけを持ち、
`latex`は空文字にして本文を二重保存しない。canvas表示で保存する場合は、旧クライアントが
`layout.blocks[].latex`を本文として読むため、従来どおり各ブロックの本文も残す。

`node tests/canvas-layout-persistence.test.mjs`は、canvasで保存したノートの
`layout.blocks[].latex`に`legacy-canvas`が残ることも確認する。旧版へ戻ってもcanvas本文は消えない。
旧版で行表示のノートを再保存すると座標を保持できない点は、その旧版に存在するC4の既知制約である。

## 実行記録

今回実行したコマンドと結果は次のとおり。

```text
node tests/canvas-layout-persistence.test.mjs
PASS (0 failures)

node tests/settings-modal-caret-dictionary.test.mjs
17 passed, 0 failed

node tests/canvas-narrow-blocks.test.mjs
63 passed, 0 failed

node tests/canvas-board.test.mjs
全項目成功（最後のcanvas blockを削除した後も0 blockで復元）

npx --prefix cloud vitest run
今回のCanvas・設定・狭幅テストは成功。全体出力には入力構造担当領域の積分Backspace失敗が1件あり、
この担当範囲の変更とは無関係として統合側で扱う。
```

## 入力・編集担当の受入記録（A1-A6、B1、F2-F3）

| 項目 | 受入結果 | 証拠 | 残る確認 |
| --- | --- | --- | --- |
| A1 Undo/Redo | 合格 | Ctrl+Z、Ctrl+Shift+Z、Ctrl+YとCmd+Zで式・行の作成削除を確認。Canvasでは本文Undo後に加え、行追加をUndoしてDOMを再構成する経路でもdrag座標をID基準で保持: `tests/undo-redo.test.mjs`、`tests/input-basics-regression.test.mjs`、`tests/canvas-block-drag-select.test.mjs` | Mac実機のCmd+Shift+Z/Cmd+Y |
| A2 変換中の旧キー漏れ | 合格 | 変換層でショートカットを先に捕捉し、Undoが旧記号入力へ流れない経路を回帰: `tests/undo-redo.test.mjs` | Mac実機IME |
| A3 1ブロック改行 | 合格 | Shift+Enter後もblock数1、LaTeXに`\\`を含む: `tests/input-basics-regression.test.mjs` | 長い途中式の実機表示 |
| A4 文キー | 合格 | `ぶんしょう`で`\\text{}`のネイティブ文章入力を開く: `tests/input-basics-regression.test.mjs` | MacかなIME |
| A5 構造の外から一打削除 | 合格 | 中身のある積分・括弧もArrowRight後のBackspaceで全体削除。構造内は通常編集: `tests/empty-structure-exit.test.mjs`、`tests/fix-regression.test.mjs` | 実機で他構造種 |
| A6 範囲選択コピー | 合格 | `123`からShift+Leftを2回で末尾`23`の実ハイライトを確認し、逆向き範囲を正規化して実際のClipboard APIへ書込み・読戻しまで確認。部分コピー後の貼り付けは旧block clipboardを使わない: `tests/input-basics-regression.test.mjs` | Mac実機 |
| B1 Enterの挿入・番号連続 | 合格 | 現在行の直後へblockを挿入しUndo/Redoできる: `tests/undo-redo.test.mjs` | 中間行の実機番号表示 |
| F2 ベクトル単元のパレット | 合格 | パレット表示、ベクトル記号の先頭表示と入力を確認: `tests/unit-system.test.mjs` | Mac実機 |
| F3 旧入力前提テスト | 是正済み | Undo・保存表示・見直しUIの打鍵を変換入力の読み+Enter確定へ移行し、受入条件は維持: `tests/undo-redo.test.mjs`、`tests/save-indicator.test.mjs`、`tests/review-ui.test.mjs` | 全体実行 |

入力担当の限定実行は全て成功した。

```text
node --test tests/canvas-block-drag-select.test.mjs tests/layoutmode-undo.test.mjs tests/undo-redo.test.mjs tests/input-basics-regression.test.mjs
4 files: pass 4, fail 0

node --test tests/conversion-structured-actions.test.mjs tests/empty-structure-exit.test.mjs tests/fix-regression.test.mjs tests/save-indicator.test.mjs tests/review-ui.test.mjs
5 files: pass 5, fail 0

node --test tests/unit-system.test.mjs
1 file: pass 1, fail 0

node --test --test-concurrency=2 tests/input-basics-regression.test.mjs tests/canvas-block-drag-select.test.mjs
2 files: pass 2, fail 0（A6は実Clipboard APIの書込み・読戻し、A1は行数変更Undo後のdrag座標保持を追加確認）

node --test --test-concurrency=2 tests/*.test.mjs
41 files: pass 41, fail 0（2026-09-07、詳細は`docs/test-results-2026-09-07.log`）
```
