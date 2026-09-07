import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const origin = 'https://shikitype.example';
let count = 0;

beforeAll(async () => {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login_id TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, recovery_hash TEXT NOT NULL, google_sub TEXT, google_email TEXT, google_name TEXT, google_picture TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes (id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, unit_id TEXT NOT NULL, rows_json TEXT NOT NULL, layout_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1, title TEXT, deleted_at TEXT, PRIMARY KEY (user_id, id));
    CREATE TABLE IF NOT EXISTS auth_rate_limits (bucket_key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review_runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, note_id TEXT NOT NULL, note_updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, problem_text TEXT NOT NULL, conditions_text TEXT NOT NULL, review_kind TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(user_id, idempotency_key));
    CREATE TABLE IF NOT EXISTS review_stages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage TEXT NOT NULL, input_scope TEXT NOT NULL, output_json TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, duration_ms INTEGER, created_at TEXT NOT NULL, UNIQUE(run_id, stage));
  `);
});

async function call(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('Origin', origin);
  if (cookie) headers.set('Cookie', cookie);
  headers.set('CF-Connecting-IP', `203.0.113.${++count}`);
  return SELF.fetch(new Request(`${origin}${path}`, { ...init, headers }));
}

async function account(): Promise<{ cookie: string; noteId: string; noteUpdatedAt: string }> {
  const id = `review${Date.now()}${++count}`.slice(0, 30);
  const signup = await call('/api/auth/signup', { method: 'POST', body: JSON.stringify({ loginId: id, password: 'a-secure-password-123' }) });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers.get('Set-Cookie') || '').split(';')[0];
  const noteId = `note-${crypto.randomUUID()}`;
  const note = { id: noteId, createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z', unitId: 's3-sekibun', rows: ['x^2'], revision: 0 };
  const saved = await call(`/api/notes/${noteId}`, { method: 'PUT', body: JSON.stringify(note) }, cookie);
  expect(saved.status).toBe(200);
  const body = await saved.json<{ note: { updatedAt: string } }>();
  return { cookie, noteId, noteUpdatedAt: body.note.updatedAt };
}

describe('AI review pipeline', () => {
  it('always runs the falsifier while keeping the full student answer out of the independent solver, falsifier, and tutor requests', async () => {
    const { cookie, noteId, noteUpdatedAt } = await account();
    const inputs: Record<string, unknown>[] = [];
    const outputs = [
      { referenceSteps: ['置換する'], checkpoints: ['微分を確認'], confidence: 0.92 },
      { strengths: ['置換の発想は正しい'], corrections: [{ blockId: 'block-1', text: '微分係数をもう一度確認' }], firstMismatchBlockId: 'block-1', issueTypes: ['係数'], hintDirection: '置換に伴う微分係数を見直す', correctSummary: '置換の方針は正しい', confidence: 0.91, needsFalsifier: false },
      { verdict: '監査結果を撤回', disagreement: true, strengths: ['置換の発想は正しい'], corrections: [], nextStep: '微分係数を再確認', confidence: 0.9 },
      { strengths: ['置換の方針は合っています'], corrections: [{ blockId: 'block-1', text: '係数だけを見直して' }], nextStep: '置換後の微分を一行だけ確かめよう。', confidence: 0.91 },
    ];
    const realFetch = globalThis.fetch;
    const mocked = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ text: string }> }> };
      inputs.push(JSON.parse(body.input[1].content[0].text));
      return new Response(JSON.stringify({ output_text: JSON.stringify(outputs.shift()), usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', mocked);
    try {
      const response = await call('/api/reviews', { method: 'POST', body: JSON.stringify({ noteId, noteUpdatedAt, problem: '∫2x dx を求めよ', conditions: '高校数学の範囲', reviewKind: 'hint', mode: 'pipeline', blocks: [{ id: 'block-1', latex: '\\int 2x', canvasPosition: { x: 120, y: 240, order: 0 } }], idempotencyKey: `review-${crypto.randomUUID()}` }) }, cookie);
      expect(response.status).toBe(201);
      const created = await response.json<{ runId: string; mode: string; card: { nextStep: string }; stages: unknown[]; conversation: Array<{ role: string; label: string; message: string }> }>();
      expect(created).toEqual(expect.objectContaining({ mode: 'pipeline', card: expect.objectContaining({ nextStep: expect.any(String) }), stages: [{ stage: 'independent_solver', inputScope: 'problem_and_conditions' }, { stage: 'solution_auditor', inputScope: 'reference_solution_and_student_blocks' }, { stage: 'falsifier', inputScope: 'reference_and_audit_summary' }, { stage: 'tutor', inputScope: 'safe_audit_handoff_only' }] }));
      expect(created.conversation.map((entry) => entry.label)).toEqual(['解法担当', '照合担当', '反証担当', 'ヒント担当']);
      expect(JSON.stringify(created.conversation)).not.toContain('referenceSteps');
      expect(JSON.stringify(created.conversation)).not.toContain('correctSummary');
      const history = await call(`/api/notes/${noteId}/reviews`, {}, cookie);
      expect(history.status).toBe(200);
      expect(await history.json()).toEqual({ reviews: [expect.objectContaining({ runId: created.runId, problem: '∫2x dx を求めよ', conditions: '高校数学の範囲', result: expect.objectContaining({ card: expect.objectContaining({ nextStep: expect.any(String) }) }) })] });
    } finally { vi.stubGlobal('fetch', realFetch); }
    expect(inputs).toHaveLength(4);
    expect(inputs[0]).toEqual(expect.objectContaining({ problem: '∫2x dx を求めよ' }));
    expect(inputs[0]).not.toHaveProperty('studentBlocks');
    expect(inputs[1]).toHaveProperty('studentBlocks');
    expect(inputs[1].studentBlocks).toEqual([{ id: 'block-1', latex: '\\int 2x', canvasPosition: { x: 120, y: 240, order: 0 } }]);
    expect(inputs[2]).toEqual(expect.objectContaining({ reference: expect.any(Object), diagnosis: expect.any(Object) }));
    expect(inputs[2]).not.toHaveProperty('studentBlocks');
    expect(inputs[3]).toHaveProperty('safeHandoff');
    expect(inputs[3]).not.toHaveProperty('problem');
    expect(inputs[3]).not.toHaveProperty('reference');
    expect(inputs[3]).not.toHaveProperty('diagnosis');
    expect(inputs[3]).not.toHaveProperty('studentBlocks');
    expect(inputs[3].safeHandoff).toEqual({ blockId: null, issueTypes: [], hintDirection: '', correctSummary: '', strengths: ['置換の発想は正しい'] });
    const stored = await env.DB.prepare('SELECT stage, input_scope, output_json, input_tokens, output_tokens, total_tokens, duration_ms FROM review_stages ORDER BY created_at DESC LIMIT 4').all<{ stage: string; input_scope: string; output_json: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; duration_ms: number | null }>();
    expect(stored.results.map((row) => row.input_scope).sort()).toEqual(['problem_and_conditions', 'reference_and_audit_summary', 'reference_solution_and_student_blocks', 'safe_audit_handoff_only']);
    const falsifierStored = stored.results.find((row) => row.stage === 'falsifier');
    expect(JSON.parse(falsifierStored!.output_json).corrections).toEqual([]);
    expect(stored.results.every((row) => !row.output_json.includes('hidden chain-of-thought'))).toBe(true);
    expect(stored.results.every((row) => row.total_tokens === 18 && typeof row.duration_ms === 'number')).toBe(true);
  });

  it('reports run progress through /api/reviews/status while it is completing, and the finished stages afterward', async () => {
    const { cookie, noteId, noteUpdatedAt } = await account();
    const key = `review-${crypto.randomUUID()}`;
    // 見直しを送る前は該当runがまだ無いので「pending」で返る（未着手を失敗と区別する）。
    const beforeSubmit = await call(`/api/reviews/status?key=${encodeURIComponent(key)}`, {}, cookie);
    expect(beforeSubmit.status).toBe(200);
    expect(await beforeSubmit.json()).toEqual({ status: 'pending', stages: [] });

    const outputs = [
      { referenceSteps: ['置換する'], checkpoints: ['微分を確認'], confidence: 0.92 },
      { strengths: ['置換の発想は正しい'], corrections: [{ blockId: 'block-1', text: '微分係数をもう一度確認' }], firstMismatchBlockId: 'block-1', issueTypes: ['係数'], hintDirection: '置換に伴う微分係数を見直す', correctSummary: '置換の方針は正しい', confidence: 0.91, needsFalsifier: false },
      { verdict: '監査結果を支持', disagreement: false, strengths: ['置換の発想は正しい'], corrections: [{ blockId: 'block-1', text: '係数だけを見直して' }], nextStep: '微分係数を再確認', confidence: 0.9 },
      { strengths: ['置換の方針は合っています'], corrections: [{ blockId: 'block-1', text: '係数だけを見直して' }], nextStep: '置換後の微分を一行だけ確かめよう。', confidence: 0.91 },
    ];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify(outputs.shift()), usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    let response: Response;
    try {
      response = await call('/api/reviews', { method: 'POST', body: JSON.stringify({ noteId, noteUpdatedAt, problem: '∫2x dx を求めよ', conditions: '高校数学の範囲', reviewKind: 'hint', mode: 'pipeline', blocks: [{ id: 'block-1', latex: '\\int 2x' }], idempotencyKey: key }) }, cookie);
    } finally { vi.stubGlobal('fetch', realFetch); }
    expect(response.status).toBe(201);
    const created = await response.json<{ runId: string }>();

    // 完了後は結果本体と、4段階すべての実行状態がstatus経由でも取れる（進行表示の土台）。
    const afterComplete = await call(`/api/reviews/status?key=${encodeURIComponent(key)}`, {}, cookie);
    expect(afterComplete.status).toBe(200);
    const statusBody = await afterComplete.json<{ status: string; stages: Array<{ stage: string; skipped: boolean }>; result: { runId: string } }>();
    expect(statusBody.status).toBe('completed');
    expect(statusBody.result.runId).toBe(created.runId);
    expect(statusBody.stages.map((s) => s.stage)).toEqual(['independent_solver', 'solution_auditor', 'falsifier', 'tutor']);
    expect(statusBody.stages.find((s) => s.stage === 'falsifier')?.skipped).toBe(false);
    expect(statusBody.stages.find((s) => s.stage === 'tutor')?.skipped).toBe(false);
  });

  it('rejects a status lookup for another user\'s idempotency key', async () => {
    const first = await account();
    const second = await account();
    const key = `review-${crypto.randomUUID()}`;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({ referenceSteps: [], checkpoints: [], confidence: 0.5 }), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    try {
      await call('/api/reviews', { method: 'POST', body: JSON.stringify({ noteId: first.noteId, noteUpdatedAt: first.noteUpdatedAt, problem: 'xを求めよ', conditions: '', reviewKind: 'hint', mode: 'single', blocks: [{ id: 'block-1', latex: 'x=1' }], idempotencyKey: key }) }, first.cookie);
    } finally { vi.stubGlobal('fetch', realFetch); }
    const asOtherUser = await call(`/api/reviews/status?key=${encodeURIComponent(key)}`, {}, second.cookie);
    expect(asOtherUser.status).toBe(200);
    expect(await asOtherUser.json()).toEqual({ status: 'pending', stages: [] });
  });

  it('returns a clear setup error before calling the model when the secret is unavailable', async () => {
    const { cookie, noteId, noteUpdatedAt } = await account();
    const original = env.OPENAI_API_KEY;
    env.OPENAI_API_KEY = undefined as never;
    try {
      const response = await call('/api/reviews', { method: 'POST', body: JSON.stringify({ noteId, noteUpdatedAt, problem: 'xを求めよ', conditions: '', reviewKind: 'hint', mode: 'pipeline', blocks: [{ id: 'block-1', latex: 'x=1' }], idempotencyKey: `review-${crypto.randomUUID()}` }) }, cookie);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'review_not_configured' });
    } finally { env.OPENAI_API_KEY = original; }
  });

  it('rejects a review snapshot after the saved note has changed', async () => {
    const { cookie, noteId } = await account();
    const response = await call('/api/reviews', { method: 'POST', body: JSON.stringify({ noteId, noteUpdatedAt: '2026-08-28T00:00:00.000Z', problem: 'xを求めよ', conditions: '', reviewKind: 'hint', mode: 'pipeline', blocks: [{ id: 'block-1', latex: 'x=1' }], idempotencyKey: `review-${crypto.randomUUID()}` }) }, cookie);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'note_stale' });
  });

  it('keeps review chat owned, completed, bounded, idempotent, and grounded in the owner\'s review context', async () => {
    const first = await account(); const other = await account();
    const seen: Record<string, unknown>[] = [];
    let chatBody: { message: string } | null = null;
    const replies = [
      { strengths: ['式を確認できています'], corrections: [], nextStep: '次の変形を一行ずつ確かめましょう。', confidence: 0.8 },
      { message: 'x=1 と書いた根拠を、問題の条件と照らして確認してください。' },
    ];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: Array<{ content: Array<{ text: string }> }> };
      seen.push(JSON.parse(body.input[1].content[0].text));
      return new Response(JSON.stringify({ output_text: JSON.stringify(replies.shift()), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    try {
      const createdResponse = await call('/api/reviews', { method: 'POST', body: JSON.stringify({ noteId: first.noteId, noteUpdatedAt: first.noteUpdatedAt, problem: '秘密の問題文', conditions: '秘密の条件', reviewKind: 'hint', mode: 'single', blocks: [{ id: 'block-1', latex: 'secret-answer' }], idempotencyKey: `review-${crypto.randomUUID()}` }) }, first.cookie);
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json<{ runId: string }>(); const key = `review-chat-${crypto.randomUUID()}`;
      const unauthenticated = await call('/api/reviews/chat', { method: 'POST', body: JSON.stringify({ runId: created.runId, message: 'どう確認する？', idempotencyKey: key }) });
      expect(unauthenticated.status).toBe(401);
      const forbidden = await call('/api/reviews/chat', { method: 'POST', body: JSON.stringify({ runId: created.runId, message: 'どう確認する？', idempotencyKey: key }) }, other.cookie);
      expect(forbidden.status).toBe(404);
      const invalid = await call('/api/reviews/chat', { method: 'POST', body: JSON.stringify({ runId: created.runId, message: 'x'.repeat(801), idempotencyKey: key }) }, first.cookie);
      expect(invalid.status).toBe(400);
      const chat = await call('/api/reviews/chat', { method: 'POST', body: JSON.stringify({ runId: created.runId, message: 'どう確認する？', idempotencyKey: key }) }, first.cookie);
      expect(chat.status).toBe(200); chatBody = await chat.json<{ message: string }>(); expect(chatBody).toEqual({ message: expect.any(String) });
      const replay = await call('/api/reviews/chat', { method: 'POST', body: JSON.stringify({ runId: created.runId, message: 'どう確認する？', idempotencyKey: key }) }, first.cookie);
      expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ message: expect.any(String) });
      const conflict = await call('/api/reviews/chat', { method: 'POST', body: JSON.stringify({ runId: created.runId, message: '別の質問', idempotencyKey: key }) }, first.cookie);
      expect(conflict.status).toBe(409);
      const history = await call(`/api/notes/${first.noteId}/reviews`, {}, first.cookie);
      expect(JSON.stringify(await history.json())).toContain('どう確認する？');
      const storedRun = await env.DB.prepare('SELECT result_json FROM review_runs WHERE id = ?').bind(created.runId).first<{ result_json: string }>();
      const storedResult = JSON.parse(storedRun!.result_json) as Record<string, unknown>;
      storedResult.chat = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', message: `履歴${index}` }));
      await env.DB.prepare('UPDATE review_runs SET result_json = ? WHERE id = ?').bind(JSON.stringify(storedResult), created.runId).run();
      const limited = await call('/api/reviews/chat', { method: 'POST', body: JSON.stringify({ runId: created.runId, message: 'もう一つ', idempotencyKey: `review-chat-${crypto.randomUUID()}` }) }, first.cookie);
      expect(limited.status).toBe(409); expect(await limited.json()).toEqual({ error: 'review_chat_limit' });
    } finally { vi.stubGlobal('fetch', realFetch); }
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(expect.objectContaining({ problem: '秘密の問題文', conditions: '秘密の条件', studentBlocks: [{ id: 'block-1', latex: 'secret-answer' }], card: expect.any(Object), conversation: expect.any(Array), history: expect.any(Array), question: 'どう確認する？' }));
    expect(chatBody?.message).toContain('x=1');
  });

  it('does not overwrite a chat saved by another tab while the model is replying', async () => {
    const { cookie, noteId, noteUpdatedAt } = await account();
    let runId = '';
    let calls = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 2) {
        const row = await env.DB.prepare('SELECT result_json FROM review_runs WHERE id = ?').bind(runId).first<{ result_json: string }>();
        const result = JSON.parse(row!.result_json) as Record<string, unknown>;
        result.chat = [{ role: 'user', message: '別タブの質問' }, { role: 'assistant', message: '別タブの返答' }];
        await env.DB.prepare('UPDATE review_runs SET result_json = ? WHERE id = ?').bind(JSON.stringify(result), runId).run();
      }
      const output = calls === 1
        ? { strengths: ['答案の一行目に根拠があります'], corrections: [], nextStep: '条件と一行目を照合してください。', confidence: 0.8 }
        : { message: 'この返答は保存してはいけません。' };
      return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    try {
      const created = await call('/api/reviews', { method: 'POST', body: JSON.stringify({ noteId, noteUpdatedAt, problem: 'xを求めよ', conditions: '', reviewKind: 'hint', mode: 'single', blocks: [{ id: 'block-1', latex: 'x=1' }], idempotencyKey: `review-${crypto.randomUUID()}` }) }, cookie);
      runId = (await created.json<{ runId: string }>()).runId;
      const chat = await call('/api/reviews/chat', { method: 'POST', body: JSON.stringify({ runId, message: '確認したい', idempotencyKey: `review-chat-${crypto.randomUUID()}` }) }, cookie);
      expect(chat.status).toBe(409);
      expect(await chat.json()).toEqual({ error: 'review_chat_conflict' });
      const row = await env.DB.prepare('SELECT result_json FROM review_runs WHERE id = ?').bind(runId).first<{ result_json: string }>();
      expect(row!.result_json).toContain('別タブの返答');
      expect(row!.result_json).not.toContain('この返答は保存してはいけません。');
    } finally { vi.stubGlobal('fetch', realFetch); }
  });

  it('pages older completed reviews instead of making them disappear after the first six', async () => {
    const { cookie, noteId } = await account();
    const owner = await env.DB.prepare('SELECT user_id FROM notes WHERE id = ?').bind(noteId).first<{ user_id: string }>();
    for (let index = 0; index < 7; index += 1) {
      const id = `rev_page-${String(index).padStart(8, '0')}`;
      await env.DB.prepare('INSERT INTO review_runs (id, user_id, note_id, note_updated_at, snapshot_json, problem_text, conditions_text, review_kind, mode, status, idempotency_key, fingerprint, result_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, owner!.user_id, noteId, '2026-08-28T00:00:00.000Z', '[]', `問題${index}`, '', 'hint', 'single', 'completed', `page-${index}`, `fingerprint-${index}`, JSON.stringify({ runId: id, card: {}, chat: [] }), `2026-09-06T00:00:0${index}.000Z`, `2026-09-06T00:00:0${index}.000Z`).run();
    }
    const first = await call(`/api/notes/${noteId}/reviews`, {}, cookie);
    const firstBody = await first.json<{ reviews: Array<{ runId: string }>; nextCursor?: string }>();
    expect(firstBody.reviews).toHaveLength(6); expect(firstBody.nextCursor).toEqual(expect.any(String));
    const second = await call(`/api/notes/${noteId}/reviews?before=${encodeURIComponent(firstBody.nextCursor!)}`, {}, cookie);
    const secondBody = await second.json<{ reviews: Array<{ runId: string }>; nextCursor?: string }>();
    expect(secondBody.reviews).toHaveLength(1); expect(secondBody.nextCursor).toBeUndefined();
    expect(new Set([...firstBody.reviews, ...secondBody.reviews].map((item) => item.runId))).toHaveLength(7);
  });
});
