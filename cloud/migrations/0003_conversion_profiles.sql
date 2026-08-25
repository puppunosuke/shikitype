-- 読み辞書と手動優先順位はユーザーごとに1プロフィールとして保存する。
-- 辞書本文はJSONだが、所有権・revision・idempotencyはD1で強制する。
CREATE TABLE IF NOT EXISTS conversion_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dictionary_json TEXT NOT NULL,
  manual_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversion_profile_updates (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
);
