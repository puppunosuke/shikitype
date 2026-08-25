-- 行だけの旧ノートを壊さず、キャンバスの配置・カメラをノート単位で保存する。
-- 既存行は空のJSONからAPI側で rows モードへ後方互換復元する。
ALTER TABLE notes ADD COLUMN layout_json TEXT NOT NULL DEFAULT '{}';
