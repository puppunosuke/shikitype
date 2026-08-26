-- 段階4: ノートの名前（title）とソフトデリート（deleted_at）をクラウド同期へ乗せる。
-- 既存行は新列がNULLのまま読める（title未設定・削除されていない、という従来の実質状態と一致する）。
ALTER TABLE notes ADD COLUMN title TEXT;
ALTER TABLE notes ADD COLUMN deleted_at TEXT;
