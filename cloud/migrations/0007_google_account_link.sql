-- Googleログイン（verifyGoogleIdToken/handleGoogleLogin）はusers.google_subほかの列を
-- 前提にSELECT/UPDATE/INSERTしているが、0001時点のusersテーブルにはこれらの列が
-- 一度も追加されていなかった（本番でもGoogleログインがD1_ERRORで失敗する状態）。
-- 既存行はすべてNULL（Google未リンク）になり、パスワード/回復コードでの既存ログインは
-- 影響を受けない。
ALTER TABLE users ADD COLUMN google_sub TEXT;
ALTER TABLE users ADD COLUMN google_email TEXT;
ALTER TABLE users ADD COLUMN google_name TEXT;
ALTER TABLE users ADD COLUMN google_picture TEXT;
-- handleGoogleLoginは新規作成時のINSERT失敗を「同じgoogle_subで既に作成済み」の
-- サインとして再読込するため、その前提となるUNIQUE制約を実際に張る（partial indexで
-- NULL同士の重複=未リンク行は許容する）。
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users(google_sub) WHERE google_sub IS NOT NULL;
