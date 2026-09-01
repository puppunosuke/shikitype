import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

let serial = 0;
const nextId = (prefix: string) => `${prefix}${Date.now()}${++serial}`.slice(0, 30);
const origin = 'https://shikitype.example';

beforeAll(async () => {
  await env.DB.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, login_id TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, recovery_hash TEXT NOT NULL, google_sub TEXT, google_email TEXT, google_name TEXT, google_picture TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX users_google_sub_idx ON users(google_sub) WHERE google_sub IS NOT NULL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE notes (id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, unit_id TEXT NOT NULL, rows_json TEXT NOT NULL, layout_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1, title TEXT, deleted_at TEXT, PRIMARY KEY (user_id, id));
    CREATE TABLE auth_rate_limits (bucket_key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at TEXT NOT NULL);
    CREATE TABLE note_imports (user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, idempotency_key));
    CREATE TABLE conversion_profiles (user_id TEXT PRIMARY KEY, dictionary_json TEXT NOT NULL, manual_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE TABLE conversion_profile_updates (user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, idempotency_key));
    CREATE TRIGGER notes_limit_before_insert BEFORE INSERT ON notes WHEN (SELECT COUNT(*) FROM notes WHERE user_id = NEW.user_id) >= 100 BEGIN SELECT RAISE(ABORT, 'note_limit'); END;
  `);
});

async function call(path: string, init: RequestInit = {}, cookie?: string, ip = `198.51.100.${serial % 220 + 1}`): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('Origin', origin);
  if (cookie) headers.set('Cookie', cookie);
  headers.set('CF-Connecting-IP', ip);
  return SELF.fetch(new Request(`${origin}${path}`, { ...init, headers }));
}

async function signup(prefix = 'user'): Promise<{ id: string; cookie: string; recoveryCode: string }> {
  const id = nextId(prefix);
  const response = await call('/api/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: id, password: 'a-secure-password-123' }) });
  expect(response.status).toBe(201);
  const body = await response.json<{ user: { id: string }; recoveryCode: string }>();
  const setCookie = response.headers.get('Set-Cookie') || '';
  return { id: body.user.id, cookie: setCookie.split(';')[0], recoveryCode: body.recoveryCode };
}

function note(id: string, revision = 0) {
  return { id, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', unitId: 's3-sekibun', rows: ['x^2'], revision };
}

function canvasNote(id: string, revision = 0) {
  return {
    ...note(id, revision),
    layout: {
      mode: 'canvas',
      camera: { x: 188, y: -42, zoom: 1.35 },
      blocks: [{ latex: 'x^2', x: 320, y: 460 }],
    },
  };
}

function emptyCanvasNote(id: string, revision = 0) {
  return {
    ...note(id, revision),
    rows: [],
    layout: { mode: 'canvas', camera: { x: 188, y: -42, zoom: 1.35 }, blocks: [] },
  };
}

function emptyRowsNote(id: string, revision = 0) {
  return {
    ...note(id, revision),
    rows: [''],
    layout: { mode: 'rows', camera: { x: 72, y: 54, zoom: 1 }, blocks: [] },
  };
}

function profile() {
  return {
    dictionary: {
      version: 1,
      additions: { 'custom-delta': { id: 'custom-delta', label: 'Δ', latex: '\\Delta', basePriority: 360, aliases: ['でるた'] } },
      addedAliases: {}, deletedAliases: {}, deletedCandidates: [],
    },
    manual: { version: 1, priorities: { 'custom-delta': 20 } },
  };
}

describe('SHIKITYPE auth and notes', () => {
  it('creates a session with hardened cookie attributes and never exposes a password hash', async () => {
    const account = await signup();
    expect(account.recoveryCode).toMatch(/^ST-[A-F0-9]{32}$/);
    const me = await call('/api/auth/me', {}, account.cookie);
    expect(await me.json()).toEqual({ user: { id: account.id, name: null, googleLinked: false } });
    const headers = (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ loginId: account.id, password: 'a-secure-password-123' }) })).headers.get('Set-Cookie') || '';
    expect(headers).toContain('__Host-shikitype_session=');
    expect(headers).toContain('HttpOnly');
    expect(headers).toContain('Secure');
    expect(headers).toContain('SameSite=Strict');
  });

  it('hides Google sign-in configuration until a production client ID is supplied', async () => {
    const response = await call('/api/auth/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ googleClientId: null, csrfToken: expect.stringMatching(/^[a-f0-9]{48}$/) });
    expect(response.headers.get('Set-Cookie')).toContain('__Host-shikitype_google_csrf=');
    const blocked = await call('/api/auth/google', { method: 'POST', body: '{}' });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: 'google_not_configured' });
  });

  it('keeps notes isolated between accounts', async () => {
    const left = await signup('left');
    const right = await signup('right');
    const id = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(note(id)) }, left.cookie)).status).toBe(200);
    expect(await (await call('/api/notes', {}, right.cookie)).json()).toEqual({ notes: [] });
  });

  it('round-trips canvas blocks and camera while old rows notes remain compatible', async () => {
    const account = await signup('canvas');
    const canvasId = `note-${crypto.randomUUID()}`;
    const saved = await call(`/api/notes/${canvasId}`, { method: 'PUT', body: JSON.stringify(canvasNote(canvasId)) }, account.cookie);
    expect(saved.status).toBe(200);
    const listed = await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ id: string; layout: { mode: string; camera: { zoom: number }; blocks: Array<{ x: number; y: number }> } }> }>();
    expect(listed.notes.find((entry) => entry.id === canvasId)?.layout).toEqual(expect.objectContaining({ mode: 'canvas', camera: expect.objectContaining({ zoom: 1.35 }), blocks: [expect.objectContaining({ x: 320, y: 460 })] }));
    const rowsId = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${rowsId}`, { method: 'PUT', body: JSON.stringify(note(rowsId)) }, account.cookie)).status).toBe(200);
    const refreshed = await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ id: string; layout: { mode: string } }> }>();
    expect(refreshed.notes.find((entry) => entry.id === rowsId)?.layout).toEqual(expect.objectContaining({ mode: 'rows', blocks: [] }));
    const unsafe = { ...canvasNote(`note-${crypto.randomUUID()}`), layout: { ...canvasNote(`note-${crypto.randomUUID()}`).layout, blocks: [{ latex: 'x', x: 99_999, y: 1 }] } };
    expect((await call(`/api/notes/${unsafe.id}`, { method: 'PUT', body: JSON.stringify(unsafe) }, account.cookie)).status).toBe(400);
  });

  it('round-trips pasted canvas images and counts an image-only note as content', async () => {
    const account = await signup('canvasimage');
    const id = `note-${crypto.randomUUID()}`;
    const image = { id: `block-${crypto.randomUUID()}`, src: 'data:image/webp;base64,AAAA', x: 210, y: 180, width: 320, height: 240 };
    const payload = { ...emptyCanvasNote(id), layout: { ...emptyCanvasNote(id).layout, images: [image] } };
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(payload) }, account.cookie)).status).toBe(200);
    const listed = await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ id: string; layout: { images: typeof image[] } }> }>();
    expect(listed.notes.find((entry) => entry.id === id)?.layout.images).toEqual([image]);
  });

  it('adds stable block IDs to legacy notes without using their current row index as a review target', async () => {
    const account = await signup('blockids');
    const id = `note-${crypto.randomUUID()}`;
    // blockIdsを持たない旧形式を受け入れ、読み出しで決定的な移行IDを補完する。
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(note(id)) }, account.cookie)).status).toBe(200);
    const first = await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ id: string; revision: number; layout: { blockIds: string[] } }> }>();
    const saved = first.notes.find((entry) => entry.id === id);
    expect(saved?.layout.blockIds).toEqual([expect.stringMatching(/^block-/)]);
    const update = { ...note(id, saved?.revision), layout: { mode: 'rows', camera: { x: 72, y: 54, zoom: 1 }, blocks: [], blockIds: saved?.layout.blockIds } };
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(update) }, account.cookie)).status).toBe(200);
    const second = await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ id: string; layout: { blockIds: string[] } }> }>();
    expect(second.notes.find((entry) => entry.id === id)?.layout.blockIds).toEqual(saved?.layout.blockIds);
  });

  it('syncs note title and soft-delete across devices, and treats old rows lacking them as name-less and not deleted', async () => {
    const account = await signup('titledelete');
    const id = `note-${crypto.randomUUID()}`;
    // 段階3まではtitle/deletedAtを送らないクライアントがあった。未指定はnullとして通る。
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(note(id)) }, account.cookie)).status).toBe(200);
    let listed = await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ id: string; title: string | null; deletedAt: string | null }> }>();
    expect(listed.notes.find((entry) => entry.id === id)).toEqual(expect.objectContaining({ title: null, deletedAt: null }));

    // 名前を付けると別端末（同じアカウントの再取得）でもそのまま見える。
    const named = { ...note(id, 1), title: '積分のメモ' };
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(named) }, account.cookie)).status).toBe(200);
    listed = await (await call('/api/notes', {}, account.cookie)).json();
    expect(listed.notes.find((entry) => entry.id === id)).toEqual(expect.objectContaining({ title: '積分のメモ' }));

    // ソフトデリート（deletedAt）も同期し、再ログインのマージで復活しない。
    const deletedAt = new Date().toISOString();
    const trashed = { ...note(id, 2), title: '積分のメモ', deletedAt };
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(trashed) }, account.cookie)).status).toBe(200);
    listed = await (await call('/api/notes', {}, account.cookie)).json();
    expect(listed.notes.find((entry) => entry.id === id)).toEqual(expect.objectContaining({ title: '積分のメモ', deletedAt }));

    // 復元（deletedAt=null）も同期する。
    const restored = { ...note(id, 3), title: '積分のメモ', deletedAt: null };
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(restored) }, account.cookie)).status).toBe(200);
    listed = await (await call('/api/notes', {}, account.cookie)).json();
    expect(listed.notes.find((entry) => entry.id === id)).toEqual(expect.objectContaining({ title: '積分のメモ', deletedAt: null }));

    // 壊れた値は拒否する（同期の穴からXSS/巨大値を持ち込まない）。
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify({ ...note(id, 4), title: 'x'.repeat(500) }) }, account.cookie)).status).toBe(200);
    listed = await (await call('/api/notes', {}, account.cookie)).json();
    // 80文字で丸められる（クライアントのsanitizeNoteTitleと同じ丸め）。
    expect(listed.notes.find((entry) => entry.id === id)?.title?.length).toBe(80);
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify({ ...note(id, 5), deletedAt: 'not-a-date' }) }, account.cookie)).status).toBe(400);
  });

  it('keeps an existing canvas note after its final block is removed without creating fresh blank notes', async () => {
    const account = await signup('emptycanvas');
    const id = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(canvasNote(id)) }, account.cookie)).status).toBe(200);
    const cleared = emptyCanvasNote(id, 1);
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(cleared) }, account.cookie)).status).toBe(200);
    const listed = await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ id: string; rows: string[]; layout: { mode: string; blocks: unknown[] } }> }>();
    expect(listed.notes.find((entry) => entry.id === id)).toEqual(expect.objectContaining({ rows: [], layout: expect.objectContaining({ mode: 'canvas', blocks: [] }) }));
    const fresh = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${fresh}`, { method: 'PUT', body: JSON.stringify(emptyCanvasNote(fresh)) }, account.cookie)).status).toBe(400);
  });

  it('keeps an existing rows note after its final contents are erased without creating fresh blank rows notes', async () => {
    const account = await signup('emptyrows');
    const id = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(note(id)) }, account.cookie)).status).toBe(200);
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(emptyRowsNote(id, 1)) }, account.cookie)).status).toBe(200);
    const listed = await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ id: string; rows: string[]; layout: { mode: string; blocks: unknown[] } }> }>();
    expect(listed.notes.find((entry) => entry.id === id)).toEqual(expect.objectContaining({ rows: [''], layout: expect.objectContaining({ mode: 'rows', blocks: [] }) }));
    const fresh = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${fresh}`, { method: 'PUT', body: JSON.stringify(emptyRowsNote(fresh)) }, account.cookie)).status).toBe(400);
  });

  it('keeps conversion dictionaries and manual priority isolated, revisioned, and idempotent', async () => {
    const left = await signup('dictionaryleft');
    const right = await signup('dictionaryright');
    expect(await (await call('/api/conversion-profile', {}, left.cookie)).json()).toEqual({ profile: expect.objectContaining({ revision: 0 }) });
    const body = JSON.stringify({ ...profile(), revision: 0, idempotencyKey: `profile-${crypto.randomUUID()}` });
    const saved = await call('/api/conversion-profile', { method: 'PUT', body }, left.cookie);
    expect(saved.status).toBe(200);
    expect((await saved.json<{ profile: { revision: number; dictionary: { additions: Record<string, unknown> } } }>()).profile).toEqual(expect.objectContaining({ revision: 1, dictionary: expect.objectContaining({ additions: expect.objectContaining({ 'custom-delta': expect.any(Object) }) }) }));
    expect((await (await call('/api/conversion-profile', {}, right.cookie)).json<{ profile: { revision: number; dictionary: { additions: Record<string, unknown> } } }>()).profile).toEqual(expect.objectContaining({ revision: 0, dictionary: expect.objectContaining({ additions: {} }) }));
    expect((await call('/api/conversion-profile', { method: 'PUT', body }, left.cookie)).status).toBe(200);
    const stale = await call('/api/conversion-profile', { method: 'PUT', body: JSON.stringify({ ...profile(), revision: 0, idempotencyKey: `profile-${crypto.randomUUID()}` }) }, left.cookie);
    expect(stale.status).toBe(200); // 同じ内容は古いrevisionでも安全に再確認できる。
    const invalid = await call('/api/conversion-profile', { method: 'PUT', body: JSON.stringify({ ...profile(), dictionary: { ...profile().dictionary, additions: { unsafe: { id: 'unsafe', label: 'x', latex: '\\htmlClass{bad}', basePriority: 1, aliases: ['x'] } } }, revision: 1, idempotencyKey: `profile-${crypto.randomUUID()}` }) }, left.cookie);
    expect(invalid.status).toBe(400);
  });

  it('imports local notes without discarding a conflicting note', async () => {
    const account = await signup('import');
    const id = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(note(id)) }, account.cookie)).status).toBe(200);
    const changed = { ...note(id), rows: ['y^2'] };
    const response = await call('/api/notes/import', { method: 'POST', body: JSON.stringify({ notes: [changed], idempotencyKey: `import-${crypto.randomUUID()}` }) }, account.cookie);
    expect(response.status).toBe(200);
    expect((await response.json<{ conflicts: number }>()).conflicts).toBe(1);
    const all = await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ rows: string[] }> }>();
    expect(all.notes.map((item) => item.rows[0]).sort()).toEqual(['x^2', 'y^2']);
  });

  it('returns a conflict instead of overwriting a newer edit', async () => {
    const account = await signup('conflict');
    const id = `note-${crypto.randomUUID()}`;
    const first = await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(note(id)) }, account.cookie);
    const saved = await first.json<{ note: { revision: number } }>();
    const latest = { ...note(id, saved.note.revision), rows: ['z^2'] };
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(latest) }, account.cookie)).status).toBe(200);
    const stale = await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify({ ...note(id), rows: ['lost'] }) }, account.cookie);
    expect(stale.status).toBe(409);
    expect((await stale.json<{ note: { rows: string[] } }>()).note.rows).toEqual(['z^2']);
  });

  it('rejects cross-origin writes and oversized payloads', async () => {
    const account = await signup('origin');
    const id = `note-${crypto.randomUUID()}`;
    const foreign = await SELF.fetch(new Request(`${origin}/api/notes/${id}`, { method: 'PUT', headers: { Cookie: account.cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(note(id)) }));
    expect(foreign.status).toBe(403);
    const huge = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ loginId: account.id, password: 'x'.repeat(300000) }) });
    expect(huge.status).toBe(413);
  });

  it('supports recovery while invalidating the previous session', async () => {
    const account = await signup('recovery');
    const reset = await call('/api/auth/recover', { method: 'POST', body: JSON.stringify({ loginId: account.id, recoveryCode: account.recoveryCode, newPassword: 'another-secure-password-456' }) });
    expect(reset.status).toBe(200);
    const rotated = await reset.json<{ recoveryCode: string }>();
    expect(rotated.recoveryCode).toMatch(/^ST-[A-F0-9]{32}$/);
    expect(await (await call('/api/auth/me', {}, account.cookie)).json()).toEqual({ user: null });
    expect((await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ loginId: account.id, password: 'another-secure-password-456' }) })).status).toBe(200);
    expect((await call('/api/auth/recover', { method: 'POST', body: JSON.stringify({ loginId: account.id, recoveryCode: account.recoveryCode, newPassword: 'third-secure-password-789' }) })).status).toBe(401);
  });

  it('limits repeated authentication attempts before expensive password work', async () => {
    const ip = '203.0.113.241';
    for (let i = 0; i < 8; i++) {
      expect((await call('/api/auth/signup', { method: 'POST', body: '{}' }, undefined, ip)).status).toBe(400);
    }
    expect((await call('/api/auth/signup', { method: 'POST', body: '{}' }, undefined, ip)).status).toBe(429);
  });

  it('atomically rate-limits parallel attempts', async () => {
    const ip = '203.0.113.242';
    const responses = await Promise.all(Array.from({ length: 16 }, () => call('/api/auth/signup', { method: 'POST', body: '{}' }, undefined, ip)));
    expect(responses.filter((response) => response.status === 400)).toHaveLength(8);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(8);
  });

  it('enforces the 100-note cap for PUT and import', async () => {
    const account = await signup('cap');
    const seed = Array.from({ length: 100 }, (_, index) => note(`note-${crypto.randomUUID()}-${index}`));
    const imported = await call('/api/notes/import', { method: 'POST', body: JSON.stringify({ notes: seed, idempotencyKey: `import-${crypto.randomUUID()}` }) }, account.cookie);
    expect(imported.status).toBe(200);
    const overflowId = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${overflowId}`, { method: 'PUT', body: JSON.stringify(note(overflowId)) }, account.cookie)).status).toBe(409);
    const extra = note(`note-${crypto.randomUUID()}`);
    const overflowImport = await call('/api/notes/import', { method: 'POST', body: JSON.stringify({ notes: [extra], idempotencyKey: `import-${crypto.randomUUID()}` }) }, account.cookie);
    expect(overflowImport.status).toBe(409);
    expect(await overflowImport.json()).toEqual({ error: 'note_limit' });
  });

  it('permanently deletes a note through DELETE, frees its slot, and never touches another account\'s note', async () => {
    const account = await signup('harddelete');
    const id = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(note(id)) }, account.cookie)).status).toBe(200);
    const other = await signup('harddelete-other');
    const otherId = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${otherId}`, { method: 'PUT', body: JSON.stringify(note(otherId)) }, other.cookie)).status).toBe(200);

    // 他人のノートidを渡しても消せない（WHERE user_id絞り込みの担保）。
    const cross = await call(`/api/notes/${otherId}`, { method: 'DELETE' }, account.cookie);
    expect(cross.status).toBe(200);
    expect(await cross.json()).toEqual({ ok: true, deleted: false });
    expect(await (await call('/api/notes', {}, other.cookie)).json<{ notes: Array<{ id: string }> }>()).toEqual({ notes: [expect.objectContaining({ id: otherId })] });

    // 自分のノートは物理削除される。
    const removed = await call(`/api/notes/${id}`, { method: 'DELETE' }, account.cookie);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, deleted: true });
    expect(await (await call('/api/notes', {}, account.cookie)).json()).toEqual({ notes: [] });

    // 再試行（既に消えている）もエラーにせず冪等に成功扱いにする。
    const retry = await call(`/api/notes/${id}`, { method: 'DELETE' }, account.cookie);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, deleted: false });

    // 100件枠がDELETEした分だけ実際に空く。99件埋めて101件目まで置けることを確認する。
    const seed = Array.from({ length: 99 }, (_, index) => note(`note-${crypto.randomUUID()}-${index}`));
    expect((await call('/api/notes/import', { method: 'POST', body: JSON.stringify({ notes: seed, idempotencyKey: `import-${crypto.randomUUID()}` }) }, account.cookie)).status).toBe(200);
    const filler = note(`note-${crypto.randomUUID()}`);
    expect((await call(`/api/notes/${filler.id}`, { method: 'PUT', body: JSON.stringify(filler) }, account.cookie)).status).toBe(200);
    const overflow = note(`note-${crypto.randomUUID()}`);
    expect((await call(`/api/notes/${overflow.id}`, { method: 'PUT', body: JSON.stringify(overflow) }, account.cookie)).status).toBe(409);
  });

  it('requires a session and same-origin request before DELETE takes effect', async () => {
    const account = await signup('deleteauth');
    const id = `note-${crypto.randomUUID()}`;
    expect((await call(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(note(id)) }, account.cookie)).status).toBe(200);
    expect((await call(`/api/notes/${id}`, { method: 'DELETE' })).status).toBe(401);
    const foreign = await SELF.fetch(new Request(`${origin}/api/notes/${id}`, { method: 'DELETE', headers: { Cookie: account.cookie, Origin: 'https://evil.example' } }));
    expect(foreign.status).toBe(403);
    // どちらの拒否経路でもノートは残っている。
    expect(await (await call('/api/notes', {}, account.cookie)).json<{ notes: Array<{ id: string }> }>()).toEqual({ notes: [expect.objectContaining({ id })] });
  });

  it('makes repeated imports idempotent and serves static assets with security headers', async () => {
    const account = await signup('retry');
    const id = `note-${crypto.randomUUID()}`;
    const body = JSON.stringify({ notes: [note(id)], idempotencyKey: `import-${crypto.randomUUID()}` });
    expect((await call('/api/notes/import', { method: 'POST', body }, account.cookie)).status).toBe(200);
    expect((await call('/api/notes/import', { method: 'POST', body }, account.cookie)).status).toBe(200);
    const notes = await (await call('/api/notes', {}, account.cookie)).json<{ notes: unknown[] }>();
    expect(notes.notes).toHaveLength(1);
    const staticResponse = await SELF.fetch(new Request(`${origin}/index.html`));
    expect(staticResponse.status).toBe(200);
    expect(staticResponse.headers.get('X-Frame-Options')).toBe('DENY');
    expect(staticResponse.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('rejects duplicate note ids within one import batch before writing', async () => {
    const account = await signup('duplicate');
    const id = `note-${crypto.randomUUID()}`;
    const response = await call('/api/notes/import', {
      method: 'POST',
      body: JSON.stringify({ notes: [note(id), { ...note(id), rows: ['duplicate'] }], idempotencyKey: `import-${crypto.randomUUID()}` }),
    }, account.cookie);
    expect(response.status).toBe(400);
    expect(await (await call('/api/notes', {}, account.cookie)).json()).toEqual({ notes: [] });
  });

  it('treats parallel imports with the same key as the same completed transaction', async () => {
    const account = await signup('parallel');
    const id = `note-${crypto.randomUUID()}`;
    const body = JSON.stringify({ notes: [note(id)], idempotencyKey: `import-${crypto.randomUUID()}` });
    const [left, right] = await Promise.all([
      call('/api/notes/import', { method: 'POST', body }, account.cookie),
      call('/api/notes/import', { method: 'POST', body }, account.cookie),
    ]);
    expect([left.status, right.status]).toEqual([200, 200]);
    expect(await (await call('/api/notes', {}, account.cookie)).json<{ notes: unknown[] }>()).toEqual(expect.objectContaining({ notes: [expect.any(Object)] }));
    const markers = await env.DB.prepare('SELECT COUNT(*) AS count FROM note_imports WHERE user_id = (SELECT id FROM users WHERE login_id = ?)').bind(account.id).first<{ count: number }>();
    expect(markers?.count).toBe(1);
  });
});
