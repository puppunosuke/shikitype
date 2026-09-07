# 統合受入記録（2026-09-07）

対象は `backlog-2026-09-04.md` の過去指摘。コード・既存ノートを保持して修正した。

- 彩葉の独立実画面確認: 360pxヘッダー、1440px設定高さ、canvasのpan/zoom、文章入力のイベント境界は合格。
- コピー: 新規の123からShift+Leftを2回押し、末尾23の青い選択表示を確認。実クリップボードも23、選択解除後の貼り付け結果は12323。証拠は `tests/iroha-20260906-evidence/copy-selection-123.png`。
- AI見直し: 反証による誤指摘撤回時、古い不一致位置・種別・ヒント・結論を後段に渡さない。`cloud/npm run check` は35件成功。
- 実AI確認は2回実行したが、検証スクリプトの応答抽出不備により返答品質の評価は未完。応答JSONは残っておらず、成功扱いにしない。
- Mac実機の日本語変換候補確定は未確認。Windows上のイベント試験とCommand修飾キー試験は物理Macの検証とは区別する。
- 最終の全体テスト: `node --test --test-concurrency=2 tests/*.test.mjs` は41ファイル成功、失敗0。71.3秒。ログは `test-results-2026-09-07.log`。
- 公開前の復旧用version: `65c3c230-eeab-4ec7-a2da-3e76d1f09a13`。
- 修正commit `153e16d` をpushし、本番version `dbc5f3d7-4daa-42bf-a167-4821d1b56363` へ反映済み。公開app.jsはローカル修正版と全文一致。
- 彩葉が公開URLを未ログインの隔離ブラウザで操作し、実コピー23、Shift+Enterで同一ブロック改行、ヘッダーの行/canvas切替を確認。console/page errorは0件。
