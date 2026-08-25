// 旧版はOS IMEのcompositionを候補へ混ぜる前提だったため、専用IMEへ改訂後の
// 操作列は統合テストを正本にする。互換入口としてこの従来のテスト名も残す。
await import('./conversion-unified-buffer.test.mjs');
