-- 同一アカウントの101件目を、PUT/importいずれでもDB側で原子的に拒否する。
-- importではmarkerも同じbatchに入るため、上限超過時に完了印だけ残らない。
CREATE TRIGGER IF NOT EXISTS notes_limit_before_insert
BEFORE INSERT ON notes
WHEN (SELECT COUNT(*) FROM notes WHERE user_id = NEW.user_id) >= 100
BEGIN
  SELECT RAISE(ABORT, 'note_limit');
END;
