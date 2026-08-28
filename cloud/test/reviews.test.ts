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
      { verdict: '監査結果を支持', disagreement: false, strengths: ['置換の発想は正しい'], corrections: [{ blockId: 'block-1', text: '係数だけを見直して' }], nextStep: '微分係数を再確認', confidence: 0.9 },
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
      const response = await call('/api/reviews', { method: 'POST', body: JSON.stringify({ noteId, noteUpdatedAt, problem: '∫2x dx を求めよ', conditions: '高校数学の範囲', reviewKind: 'hint', mode: 'pipeline', blocks: [{ id: 'block-1', latex: '\\int 2x' }], idempotencyKey: `review-${crypto.randomUUID()}` }) }, cookie);
      expect(response.status).toBe(201);
      const created = await response.json<{ runId: string; mode: string; card: { nextStep: string }; stages: unknown[] }>();
      expect(created).toEqual(expect.objectContaining({ mode: 'pipeline', card: expect.objectContaining({ nextStep: expect.any(String) }), stages: [{ stage: 'independent_solver', inputScope: 'problem_and_conditions' }, { stage: 'solution_auditor', inputScope: 'reference_solution_and_student_blocks' }, { stage: 'falsifier', inputScope: 'reference_and_audit_summary' }, { stage: 'tutor', inputScope: 'safe_audit_handoff_only' }] }));
      const history = await call(`/api/notes/${noteId}/reviews`, {}, cookie);
      expect(history.status).toBe(200);
      expect(await history.json()).toEqual({ reviews: [expect.objectContaining({ runId: created.runId, result: expect.objectContaining({ card: expect.objectContaining({ nextStep: expect.any(String) }) }) })] });
    } finally { vi.stubGlobal('fetch', realFetch); }
    expect(inputs).toHaveLength(4);
    expect(inputs[0]).toEqual(expect.objectContaining({ problem: '∫2x dx を求めよ' }));
    expect(inputs[0]).not.toHaveProperty('studentBlocks');
    expect(inputs[1]).toHaveProperty('studentBlocks');
    expect(inputs[2]).toEqual(expect.objectContaining({ reference: expect.any(Object), diagnosis: expect.any(Object) }));
    expect(inputs[2]).not.toHaveProperty('studentBlocks');
    expect(inputs[3]).toHaveProperty('safeHandoff');
    expect(inputs[3]).not.toHaveProperty('problem');
    expect(inputs[3]).not.toHaveProperty('reference');
    expect(inputs[3]).not.toHaveProperty('diagnosis');
    expect(inputs[3]).not.toHaveProperty('studentBlocks');
    expect(inputs[3].safeHandoff).toEqual(expect.objectContaining({ blockId: 'block-1', issueTypes: ['係数'], hintDirection: expect.any(String) }));
    const stored = await env.DB.prepare('SELECT stage, input_scope, output_json, input_tokens, output_tokens, total_tokens, duration_ms FROM review_stages ORDER BY created_at DESC LIMIT 4').all<{ stage: string; input_scope: string; output_json: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; duration_ms: number | null }>();
    expect(stored.results.map((row) => row.input_scope).sort()).toEqual(['problem_and_conditions', 'reference_and_audit_summary', 'reference_solution_and_student_blocks', 'safe_audit_handoff_only']);
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
});
