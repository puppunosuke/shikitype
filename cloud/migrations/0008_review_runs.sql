-- AI見直しはノート本体と別に保存する。答案を編集しても、当時の判定と混ざらない。
CREATE TABLE IF NOT EXISTS review_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  note_updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  problem_text TEXT NOT NULL,
  conditions_text TEXT NOT NULL,
  review_kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS review_runs_user_note_idx ON review_runs(user_id, note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS review_runs_running_idx ON review_runs(user_id, status);

-- 保存するのは各段階の構造化した結論と、どこまでを見せたかだけ。思考過程や会話ログは保存しない。
CREATE TABLE IF NOT EXISTS review_stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  input_scope TEXT NOT NULL,
  output_json TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, stage)
);
