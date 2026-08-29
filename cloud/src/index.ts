import { scrypt } from 'node:crypto';
import { GoogleTokenError, verifyGoogleIdToken } from './google-id-token';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_BODY_BYTES = 256 * 1024;
const MAX_NOTE_BYTES = 220 * 1024;
const MAX_NOTES = 100;
const MAX_DICTIONARY_BYTES = 128 * 1024;
const MAX_DICTIONARY_CUSTOM_CANDIDATES = 300;
const MAX_DICTIONARY_ALIASES = 2000;
const SESSION_DAYS = 30;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 8;
const GOOGLE_CSRF_COOKIE = '__Host-shikitype_google_csrf';
const MAX_REVIEW_PROBLEM_CHARS = 8_000;
const MAX_REVIEW_CONDITIONS_CHARS = 4_000;
const MAX_REVIEW_BLOCKS = 80;
const MAX_REVIEW_BLOCK_CHARS = 4_000;
const MAX_OPENAI_RESPONSE_BYTES = 64 * 1024;

type UserRow = { id: string; login_id: string; password_hash: string; password_salt: string; recovery_hash: string; google_sub?: string | null; google_name?: string | null };
type SessionRow = { user_id: string; expires_at: string };
type NoteRow = { id: string; created_at: string; updated_at: string; unit_id: string; rows_json: string; layout_json: string; revision: number; title: string | null; deleted_at: string | null };
type ImportRow = { fingerprint: string; response_json: string };
type CanvasBlock = { id: string; latex: string; x: number; y: number };
type NoteLayout = { mode: 'rows' | 'canvas'; camera: { x: number; y: number; zoom: number }; blocks: CanvasBlock[]; blockIds: string[] };
type PublicNote = { id: string; createdAt: string; updatedAt: string; unitId: string; rows: string[]; layout: NoteLayout; revision: number; title: string | null; deletedAt: string | null };
type DictionaryEntry = { id: string; label: string; latex: string; basePriority: number; aliases: string[] };
type DictionaryState = { version: 1; additions: Record<string, DictionaryEntry>; addedAliases: Record<string, string[]>; deletedAliases: Record<string, string[]>; deletedCandidates: string[] };
type ManualPriorityState = { version: 1; priorities: Record<string, number> };
type ProfileRow = { dictionary_json: string; manual_json: string; revision: number; updated_at: string };
type ProfileUpdateRow = { fingerprint: string; response_json: string };
type PublicConversionProfile = { dictionary: DictionaryState; manual: ManualPriorityState; revision: number; updatedAt: string | null };
type ReviewBlock = { id: string; latex: string };
type ReviewRequest = { noteId: string; noteUpdatedAt: string; problem: string; conditions: string; reviewKind: 'hint' | 'review'; mode: 'single' | 'pipeline'; blocks: ReviewBlock[]; idempotencyKey: string };
type ReviewRunRow = { id: string; user_id: string; note_id: string; note_updated_at: string; snapshot_json: string; problem_text: string; conditions_text: string; review_kind: 'hint' | 'review'; mode: 'single' | 'pipeline'; status: 'running' | 'completed' | 'failed'; result_json: string | null; error_code: string | null; created_at: string; completed_at: string | null };
type ReviewStage = 'independent_solver' | 'solution_auditor' | 'falsifier' | 'tutor' | 'single';
type ReviewStageRow = { stage: ReviewStage; input_scope: string; output_json: string; input_tokens?: number | null; output_tokens?: number | null; total_tokens?: number | null; duration_ms?: number | null; created_at: string };
type ReviewCard = { strengths: string[]; corrections: Array<{ blockId: string | null; text: string }>; nextStep: string; confidence: number };
type ReviewUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
type ReviewResponse = { output: Record<string, unknown>; usage: ReviewUsage; durationMs: number };

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

function addSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data: https://lh3.googleusercontent.com; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' https://accounts.google.com/gsi/client; connect-src 'self' https://accounts.google.com https://www.googleapis.com; frame-src https://accounts.google.com");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function getCookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of (request.headers.get('Cookie') || '').split(';')) {
    const index = item.indexOf('=');
    if (index > 0) out.set(item.slice(0, index).trim(), item.slice(index + 1).trim());
  }
  return out;
}

function randomToken(bytes = 32): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function derivePasswordHash(password: string, salt: string, pepper: string): Promise<string> {
  // Workers の PBKDF2 は 100,000 回までしか受け付けないため、より強い
  // memory-hard な scrypt を使う。N=2^15, r=8, p=3 は約32 MiBを要求する。
  const derived = await new Promise<Uint8Array>((resolve, reject) => {
    scrypt(`${password}\u0000${pepper}`, salt, 32, { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error: Error | null, key: Uint8Array) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  // 接頭辞を含め、今後の方式移行時に保存値だけで識別できるようにする。
  return `scrypt-v1$${Array.from(derived, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

function validateOrigin(request: Request): void {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) throw new ApiError(403, 'forbidden');
}

function csrfCookie(token: string): string {
  return `${GOOGLE_CSRF_COOKIE}=${token}; Path=/; Max-Age=3600; Secure; SameSite=Strict`;
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('Content-Length') || '0');
  if (contentLength > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large');
  if (!request.body) throw new ApiError(400, 'invalid_request');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const data: unknown = JSON.parse(decoder.decode(all));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'invalid_request');
  }
}

function stringField(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (typeof value !== 'string' || !value || value.length > max) throw new ApiError(400, 'invalid_request');
  return value;
}

function loginId(body: Record<string, unknown>): string {
  const value = stringField(body, 'loginId', 32).toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(value)) throw new ApiError(400, 'invalid_request');
  return value;
}

function password(body: Record<string, unknown>, name: string): string {
  const value = stringField(body, name, 128);
  if (value.length < 12) throw new ApiError(400, 'invalid_request');
  return value;
}

const dictionaryIdPattern = /^[a-z][a-z0-9-]{1,63}$/;
const dictionaryLatexPattern = /^[A-Za-z0-9\\{}[\]()_^+\-*/=<>|.,:;!? \t]+$/;
const unsafeDictionaryLatex = /\\(?:html[a-z]*|class|style|href|url|includegraphics)\b/i;

function dictionaryId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return dictionaryIdPattern.test(id) ? id : null;
}

function dictionaryReading(value: unknown): string | null {
  const reading = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  return reading && reading.length <= 80 && !/[\u0000-\u001f\u007f]/.test(reading) ? reading : null;
}

function dictionaryLabel(value: unknown): string | null {
  const label = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  return label && label.length <= 32 && !/[\u0000-\u001f\u007f]/.test(label) ? label : null;
}

function dictionaryLatex(value: unknown): string | null {
  const latex = typeof value === 'string' ? value.trim() : '';
  return latex && latex.length <= 160 && dictionaryLatexPattern.test(latex) && !unsafeDictionaryLatex.test(latex) ? latex : null;
}

function dictionaryPriority(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= -1000 && value <= 1000 ? value : null;
}

function emptyDictionary(): DictionaryState { return { version: 1, additions: {}, addedAliases: {}, deletedAliases: {}, deletedCandidates: [] }; }
function emptyManual(): ManualPriorityState { return { version: 1, priorities: {} }; }

function uniqueDictionaryReadings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 120) return null;
  const readings: string[] = []; const seen = new Set<string>();
  for (const item of value) {
    const reading = dictionaryReading(item);
    const key = reading?.toLocaleLowerCase('ja');
    if (!reading || !key || seen.has(key)) return null;
    seen.add(key); readings.push(reading);
  }
  return readings;
}

function dictionaryFromUnknown(value: unknown): DictionaryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_dictionary');
  const source = value as Record<string, unknown>;
  if (source.version !== 1) throw new ApiError(400, 'invalid_dictionary');
  const state = emptyDictionary();
  if (!source.additions || typeof source.additions !== 'object' || Array.isArray(source.additions)) throw new ApiError(400, 'invalid_dictionary');
  for (const [rawId, rawEntry] of Object.entries(source.additions as Record<string, unknown>)) {
    if (Object.keys(state.additions).length >= MAX_DICTIONARY_CUSTOM_CANDIDATES || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) throw new ApiError(400, 'invalid_dictionary');
    const entry = rawEntry as Record<string, unknown>; const id = dictionaryId(rawId);
    const label = dictionaryLabel(entry.label); const latex = dictionaryLatex(entry.latex); const basePriority = dictionaryPriority(entry.basePriority); const aliases = uniqueDictionaryReadings(entry.aliases);
    if (!id || !label || !latex || basePriority === null || !aliases?.length) throw new ApiError(400, 'invalid_dictionary');
    state.additions[id] = { id, label, latex, basePriority, aliases };
  }
  for (const key of ['addedAliases', 'deletedAliases'] as const) {
    const raw = source[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'invalid_dictionary');
    const target = state[key];
    for (const [rawId, aliasesValue] of Object.entries(raw as Record<string, unknown>)) {
      const id = dictionaryId(rawId); const aliases = uniqueDictionaryReadings(aliasesValue);
      if (!id || !aliases?.length) throw new ApiError(400, 'invalid_dictionary');
      target[id] = aliases;
    }
  }
  if (!Array.isArray(source.deletedCandidates) || source.deletedCandidates.length > MAX_DICTIONARY_CUSTOM_CANDIDATES) throw new ApiError(400, 'invalid_dictionary');
  const deletedCandidates = source.deletedCandidates.map(dictionaryId);
  if (deletedCandidates.some((id) => id === null)) throw new ApiError(400, 'invalid_dictionary');
  const safeDeletedCandidates = deletedCandidates as string[];
  if (new Set(safeDeletedCandidates).size !== safeDeletedCandidates.length) throw new ApiError(400, 'invalid_dictionary');
  state.deletedCandidates = safeDeletedCandidates;
  const aliases = [...Object.values(state.additions), ...Object.values(state.addedAliases), ...Object.values(state.deletedAliases)].reduce((sum, item) => sum + (Array.isArray(item) ? item.length : item.aliases.length), 0);
  if (aliases > MAX_DICTIONARY_ALIASES || encoder.encode(JSON.stringify(state)).byteLength > MAX_DICTIONARY_BYTES) throw new ApiError(413, 'dictionary_too_large');
  return state;
}

function manualFromUnknown(value: unknown): ManualPriorityState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_dictionary');
  const source = value as Record<string, unknown>; const priorities = source.priorities;
  if (source.version !== 1 || !priorities || typeof priorities !== 'object' || Array.isArray(priorities)) throw new ApiError(400, 'invalid_dictionary');
  const result = emptyManual();
  for (const [rawId, rawPriority] of Object.entries(priorities as Record<string, unknown>)) {
    const id = dictionaryId(rawId); const priority = typeof rawPriority === 'number' && Number.isInteger(rawPriority) && rawPriority >= -50 && rawPriority <= 50 ? rawPriority : null;
    if (!id || priority === null || Object.keys(result.priorities).length >= MAX_DICTIONARY_ALIASES) throw new ApiError(400, 'invalid_dictionary');
    result.priorities[id] = priority;
  }
  return result;
}

function profileFromRow(row: ProfileRow | null): PublicConversionProfile {
  if (!row) return { dictionary: emptyDictionary(), manual: emptyManual(), revision: 0, updatedAt: null };
  try {
    return { dictionary: dictionaryFromUnknown(JSON.parse(row.dictionary_json)), manual: manualFromUnknown(JSON.parse(row.manual_json)), revision: row.revision, updatedAt: row.updated_at };
  } catch { return { dictionary: emptyDictionary(), manual: emptyManual(), revision: 0, updatedAt: null }; }
}

function noteFromUnknown(value: unknown): PublicNote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_note');
  const item = value as Record<string, unknown>;
  const id = stringField(item, 'id', 120);
  const createdAt = stringField(item, 'createdAt', 40);
  const updatedAt = stringField(item, 'updatedAt', 40);
  const unitId = stringField(item, 'unitId', 80);
  if (!/^note-[a-z0-9-]{8,120}(?:-conflict)?$/i.test(id) || Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) throw new ApiError(400, 'invalid_note');
  if (!Array.isArray(item.rows) || item.rows.length > 80 || item.rows.some((row) => typeof row !== 'string' || row.length > 4000)) throw new ApiError(400, 'invalid_note');
  const rows = item.rows as string[];
  const layout = noteLayoutFromUnknown(item.layout, rows);
  const revision = typeof item.revision === 'number' && Number.isSafeInteger(item.revision) && item.revision >= 0 ? item.revision : 0;
  const title = noteTitleFromUnknown(item.title);
  const deletedAt = noteDeletedAtFromUnknown(item.deletedAt);
  const note = { id, createdAt, updatedAt, unitId, rows, layout, revision, title, deletedAt };
  if (encoder.encode(JSON.stringify(note)).byteLength > MAX_NOTE_BYTES) throw new ApiError(413, 'note_too_large');
  return note;
}

// クライアント（sanitizeNoteTitle）と同じ丸め方: 空白だけ・80文字超はnull扱いにする。
// nullを許すのは「名前なし」を表す既存の意味と一致させるため。
function noteTitleFromUnknown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_note');
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, 80);
  return trimmed || null;
}

// クライアント（sanitizeNoteDeletedAt）と同じ丸め方: 解釈できない値はnull（未削除）扱いにする。
function noteDeletedAtFromUnknown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new ApiError(400, 'invalid_note');
  return value;
}

function isEmptyNote(note: PublicNote): boolean {
  return !note.rows.some((row) => row.replace(/\\placeholder\{\}/g, '').trim());
}

function canvasCoordinate(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 12_000 ? value : fallback;
}

function isCanvasCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 12_000;
}

function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && /^block-[a-z0-9-]{8,120}$/i.test(value);
}

// 旧ノートにはIDが無い。読み出し時に一度だけ安全に補完され、次の通常保存で
// layout_jsonへ残る。行番号をレビューIDとして使い続ける移行にはしない。
function legacyBlockId(index: number, latex: string): string {
  // crypto hash is async and note validation is intentionally synchronous. This is only a
  // deterministic bridge for old notes; the next client save replaces it with a UUID.
  let hash = 2166136261;
  for (let offset = 0; offset < latex.length; offset += 1) hash = Math.imul(hash ^ latex.charCodeAt(offset), 16777619);
  return `block-legacy-${index}-${(hash >>> 0).toString(16)}`;
}

function noteBlockIds(value: unknown, rows: string[]): string[] {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  return rows.map((latex, index) => {
    const candidate = source[index];
    let id = isBlockId(candidate) && !seen.has(candidate) ? candidate : legacyBlockId(index, latex);
    while (seen.has(id)) id = `${id}-${seen.size}`;
    seen.add(id);
    return id;
  });
}

function noteLayoutFromUnknown(value: unknown, rows: string[]): NoteLayout {
  // 行モードはrows本文だけを持つ。旧クライアントの欠落layoutも、ここでblocksへ
  // 複製しないことで大きいノートのAPI容量を不必要に二重消費しない。
  if (value === undefined || value === null) return { mode: 'rows', camera: { x: 72, y: 54, zoom: 1 }, blocks: [], blockIds: noteBlockIds(null, rows) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_note');
  const item = value as Record<string, unknown>;
  if (item.mode !== 'rows' && item.mode !== 'canvas') throw new ApiError(400, 'invalid_note');
  if (!item.camera || typeof item.camera !== 'object' || Array.isArray(item.camera)) throw new ApiError(400, 'invalid_note');
  const camera = item.camera as Record<string, unknown>;
  const zoom = typeof camera.zoom === 'number' && Number.isFinite(camera.zoom) && camera.zoom >= 0.4 && camera.zoom <= 2.5 ? camera.zoom : null;
  if (zoom === null) throw new ApiError(400, 'invalid_note');
  if (!Array.isArray(item.blocks) || item.blocks.length > 80) throw new ApiError(400, 'invalid_note');
  const blockIds = noteBlockIds(item.blockIds, rows);
  const blocks: CanvasBlock[] = item.blocks.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'invalid_note');
    const block = raw as Record<string, unknown>;
    if (typeof block.latex !== 'string' || block.latex.length > 4000 || !isCanvasCoordinate(block.x) || !isCanvasCoordinate(block.y)) throw new ApiError(400, 'invalid_note');
    return { id: isBlockId(block.id) ? block.id : blockIds[index], latex: block.latex, x: block.x, y: block.y };
  });
  if (item.mode === 'canvas' && blocks.length !== rows.length) throw new ApiError(400, 'invalid_note');
  if (!isCanvasCoordinate(camera.x) || !isCanvasCoordinate(camera.y)) throw new ApiError(400, 'invalid_note');
  const canonicalIds = noteBlockIds(blocks.length ? blocks.map((block) => block.id) : blockIds, rows);
  blocks.forEach((block, index) => { block.id = canonicalIds[index]; });
  return { mode: item.mode, camera: { x: camera.x, y: camera.y, zoom }, blocks, blockIds: canonicalIds };
}

function toPublicNote(row: NoteRow): PublicNote {
  let rows: unknown;
  try { rows = JSON.parse(row.rows_json); } catch { rows = []; }
  const safeRows = Array.isArray(rows) ? rows.filter((value): value is string => typeof value === 'string') : [];
  let layout: NoteLayout;
  try { layout = noteLayoutFromUnknown(JSON.parse(row.layout_json || 'null'), safeRows); }
  catch { layout = noteLayoutFromUnknown(null, safeRows); }
  // title/deleted_atは0005で追加した列。旧行はNULLのままで、
  // 「名前なし・未削除」という従来の実質状態とそのまま一致する。
  return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, unitId: row.unit_id, rows: safeRows, layout, revision: row.revision, title: row.title ?? null, deletedAt: row.deleted_at ?? null };
}

async function rateLimit(request: Request, env: Env, action: string): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = await sha256(`${action}\u0000${ip}\u0000${env.AUTH_PEPPER}`);
  const now = Date.now();
  const resetAt = new Date(now + RATE_WINDOW_MS).toISOString();
  // RETURNING までを1文に閉じ、SELECT→UPSERTの競合で上限を抜けないようにする。
  const current = await env.DB.prepare(`
    INSERT INTO auth_rate_limits (bucket_key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      count = CASE WHEN auth_rate_limits.reset_at <= ? THEN 1 ELSE auth_rate_limits.count + 1 END,
      reset_at = CASE WHEN auth_rate_limits.reset_at <= ? THEN excluded.reset_at ELSE auth_rate_limits.reset_at END
    RETURNING count
  `).bind(bucket, resetAt, new Date(now).toISOString(), new Date(now).toISOString()).first<{ count: number }>();
  if (!current || current.count > RATE_LIMIT) throw new ApiError(429, 'try_later');
}

async function authenticatedUser(request: Request, env: Env): Promise<string> {
  const token = getCookies(request).get('__Host-shikitype_session');
  if (!token || token.length !== 64) throw new ApiError(401, 'unauthorized');
  const hash = await sha256(`${token}\u0000${env.AUTH_PEPPER}`);
  const session = await env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').bind(hash).first<SessionRow>();
  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    if (session) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    throw new ApiError(401, 'unauthorized');
  }
  return session.user_id;
}

async function createSession(userId: string, env: Env): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256(`${token}\u0000${env.AUTH_PEPPER}`);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(`ses_${crypto.randomUUID()}`, userId, tokenHash, expires, now).run();
  return token;
}

async function sessionRecord(userId: string, env: Env): Promise<{ token: string; id: string; tokenHash: string; expires: string; now: string }> {
  const token = randomToken();
  const now = new Date().toISOString();
  return { token, id: `ses_${crypto.randomUUID()}`, tokenHash: await sha256(`${token}\u0000${env.AUTH_PEPPER}`), expires: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), now };
}

function sessionCookie(token: string): string {
  return `__Host-shikitype_session=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; Secure; HttpOnly; SameSite=Strict`;
}
function clearSessionCookie(): string { return '__Host-shikitype_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict'; }

function publicAccount(user: Pick<UserRow, 'login_id' | 'google_sub' | 'google_name'>): { id: string; name: string | null; googleLinked: boolean } {
  return { id: user.login_id, name: user.google_name || null, googleLinked: Boolean(user.google_sub) };
}

async function handleGoogleConfig(_request: Request, env: Env): Promise<Response> {
  const csrf = randomToken(24);
  return json({ googleClientId: env.GOOGLE_CLIENT_ID || null, csrfToken: csrf }, 200, { 'Set-Cookie': csrfCookie(csrf) });
}

async function verifyGoogleCsrf(request: Request, body: Record<string, unknown>): Promise<void> {
  const cookie = getCookies(request).get(GOOGLE_CSRF_COOKIE);
  const header = request.headers.get('X-Shikitype-CSRF');
  const bodyToken = typeof body.csrfToken === 'string' ? body.csrfToken : '';
  if (!cookie || !header || !bodyToken || !(await safeEqual(cookie, header)) || !(await safeEqual(cookie, bodyToken))) throw new ApiError(403, 'forbidden');
}

async function googleLoginId(sub: string, env: Env): Promise<string> {
  // Googleのsub自体は画面・URL・ログインIDへ露出させない。既存のlogin_id制約を
  // 満たす、pepper付きの固定内部IDだけを作る。
  return `g_${(await sha256(`google-login-id\u0000${sub}\u0000${env.AUTH_PEPPER}`)).slice(0, 28)}`;
}

async function handleGoogleLogin(request: Request, env: Env): Promise<Response> {
  validateOrigin(request); await rateLimit(request, env, 'google-login');
  if (!env.GOOGLE_CLIENT_ID) throw new ApiError(503, 'google_not_configured');
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'invalid_request');
  const body = await boundedJson(request);
  await verifyGoogleCsrf(request, body);
  const credential = stringField(body, 'credential', 10_000);
  let identity;
  try { identity = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID); }
  catch (error) {
    if (error instanceof GoogleTokenError) throw new ApiError(401, 'google_verification_failed');
    throw error;
  }
  const intent = body.intent === 'link' ? 'link' : 'login';
  const now = new Date().toISOString();

  if (intent === 'link') {
    const userId = await authenticatedUser(request, env);
    const existing = await env.DB.prepare('SELECT id FROM users WHERE google_sub = ?').bind(identity.sub).first<{ id: string }>();
    if (existing && existing.id !== userId) throw new ApiError(409, 'google_already_linked');
    await env.DB.prepare('UPDATE users SET google_sub = ?, google_email = ?, google_name = ?, google_picture = ?, updated_at = ? WHERE id = ?')
      .bind(identity.sub, identity.email, identity.name, identity.picture, now, userId).run();
    const linked = await env.DB.prepare('SELECT id, login_id, password_hash, password_salt, recovery_hash, google_sub, google_name FROM users WHERE id = ?').bind(userId).first<UserRow>();
    if (!linked) throw new ApiError(401, 'unauthorized');
    return json({ user: publicAccount(linked) });
  }

  // メールは照合キーにしない。Googleのsubだけを唯一の外部IDにするため、同じ
  // メールのパスワード利用者を勝手に統合したり、既存ノートを奪ったりしない。
  let user = await env.DB.prepare('SELECT id, login_id, password_hash, password_salt, recovery_hash, google_sub, google_name FROM users WHERE google_sub = ?').bind(identity.sub).first<UserRow>();
  if (user) {
    await env.DB.prepare('UPDATE users SET google_email = ?, google_name = ?, google_picture = ?, updated_at = ? WHERE id = ?')
      .bind(identity.email, identity.name, identity.picture, now, user.id).run();
    user = { ...user, google_name: identity.name };
  } else {
    const userId = `usr_${crypto.randomUUID()}`;
    const loginId = await googleLoginId(identity.sub, env);
    const salt = randomToken(16);
    const recoveryCode = randomToken(24);
    try {
      await env.DB.prepare(`
        INSERT INTO users (id, login_id, password_hash, password_salt, recovery_hash, google_sub, google_email, google_name, google_picture, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        userId, loginId, 'google-login-disabled', salt,
        await sha256(`${recoveryCode}\u0000${env.AUTH_PEPPER}`), identity.sub, identity.email, identity.name, identity.picture, now, now,
      ).run();
    } catch {
      // 競合時は同じsubで作成済みの行だけを再読込する。別の制約違反を隠さない。
      user = await env.DB.prepare('SELECT id, login_id, password_hash, password_salt, recovery_hash, google_sub, google_name FROM users WHERE google_sub = ?').bind(identity.sub).first<UserRow>();
      if (!user) throw new ApiError(409, 'google_login_failed');
    }
    user ||= { id: userId, login_id: loginId, password_hash: 'google-login-disabled', password_salt: salt, recovery_hash: '', google_sub: identity.sub, google_name: identity.name };
  }
  const token = await createSession(user.id, env);
  return json({ user: publicAccount(user) }, 200, { 'Set-Cookie': sessionCookie(token) });
}

async function signup(request: Request, env: Env): Promise<Response> {
  validateOrigin(request); await rateLimit(request, env, 'signup');
  const body = await boundedJson(request); const id = loginId(body); const pass = password(body, 'password');
  const salt = randomToken(16); const now = new Date().toISOString(); const userId = `usr_${crypto.randomUUID()}`;
  const recoveryCode = `ST-${randomToken(16).toUpperCase()}`;
  const session = await sessionRecord(userId, env);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, login_id, password_hash, password_salt, recovery_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, id, await derivePasswordHash(pass, salt, env.AUTH_PEPPER), salt, await sha256(`${recoveryCode}\u0000${env.AUTH_PEPPER}`), now, now),
      env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(session.id, userId, session.tokenHash, session.expires, session.now),
    ]);
  } catch (error) {
    console.error(JSON.stringify({ message: 'signup_failed', error: error instanceof Error ? error.message : 'unknown' }));
    throw new ApiError(400, 'signup_failed');
  }
  return json({ user: { id }, recoveryCode }, 201, { 'Set-Cookie': sessionCookie(session.token) });
}

async function login(request: Request, env: Env): Promise<Response> {
  validateOrigin(request); await rateLimit(request, env, 'login');
  const body = await boundedJson(request); const id = loginId(body); const pass = password(body, 'password');
  const user = await env.DB.prepare('SELECT id, login_id, password_hash, password_salt, recovery_hash, google_sub, google_name FROM users WHERE login_id = ?').bind(id).first<UserRow>();
  const dummySalt = await sha256(`missing-user-salt\u0000${env.AUTH_PEPPER}`);
  const dummyHash = await derivePasswordHash('missing-user-password', dummySalt, env.AUTH_PEPPER);
  const calculated = await derivePasswordHash(pass, user?.password_salt || dummySalt, env.AUTH_PEPPER);
  if (!user || !(await safeEqual(calculated, user?.password_hash || dummyHash))) throw new ApiError(401, 'invalid_credentials');
  const token = await createSession(user.id, env);
  // パスワードログインでも、事前にGoogle連携済みのアカウントならその情報を返す。
  // ここを{id}だけにすると、連携済みユーザーがパスワードでログインし直した
  // 直後だけ「連携」ボタンが誤って再表示される（次のリロード＝/auth/meで直るまでの間だけ）。
  return json({ user: publicAccount(user) }, 200, { 'Set-Cookie': sessionCookie(token) });
}

async function recover(request: Request, env: Env): Promise<Response> {
  validateOrigin(request); await rateLimit(request, env, 'recover');
  const body = await boundedJson(request); const id = loginId(body); const code = stringField(body, 'recoveryCode', 160); const next = password(body, 'newPassword');
  const user = await env.DB.prepare('SELECT id, login_id, password_hash, password_salt, recovery_hash, google_sub, google_name FROM users WHERE login_id = ?').bind(id).first<UserRow>();
  const provided = await sha256(`${code}\u0000${env.AUTH_PEPPER}`);
  const dummyRecovery = await sha256(`missing-recovery\u0000${env.AUTH_PEPPER}`);
  if (!user || !(await safeEqual(provided, user?.recovery_hash || dummyRecovery))) throw new ApiError(401, 'invalid_credentials');
  const salt = randomToken(16); const now = new Date().toISOString();
  const recoveryCode = `ST-${randomToken(16).toUpperCase()}`;
  const session = await sessionRecord(user.id, env);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, recovery_hash = ?, updated_at = ? WHERE id = ?').bind(await derivePasswordHash(next, salt, env.AUTH_PEPPER), salt, await sha256(`${recoveryCode}\u0000${env.AUTH_PEPPER}`), now, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(session.id, user.id, session.tokenHash, session.expires, session.now),
  ]);
  return json({ user: publicAccount(user), recoveryCode }, 200, { 'Set-Cookie': sessionCookie(session.token) });
}

async function listNotes(request: Request, env: Env): Promise<Response> {
  const userId = await authenticatedUser(request, env);
  const result = await env.DB.prepare('SELECT id, created_at, updated_at, unit_id, rows_json, layout_json, revision, title, deleted_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').bind(userId, MAX_NOTES).all<NoteRow>();
  return json({ notes: result.results.map(toPublicNote) });
}

// 「完全に削除」専用の物理削除の口。deletedAt（ソフトデリート）はゴミ箱表示のための
// 状態に過ぎず、行はDBに残り続けてMAX_NOTESの100件枠を占有し続ける。これを実際に
// 空けるには行そのものを消す必要があるため、putNoteとは別にDELETEを設ける。
// user_id = ? を必ずWHEREへ含め、他ユーザーのidを渡されても自分の行以外には
// 一切当たらないようにする（putNote/listNotesと同じ絞り込み方針）。
// 既に存在しない（前回の再試行がサーバへ届いていた等）場合もエラーにせず、
// deleted: false を返して成功扱いにする。削除は本質的に冪等な操作であり、
// クライアント側の再試行ループがここで詰まらないようにするため。
async function deleteNote(request: Request, env: Env, id: string): Promise<Response> {
  validateOrigin(request);
  const userId = await authenticatedUser(request, env);
  const result = await env.DB.prepare('DELETE FROM notes WHERE user_id = ? AND id = ?').bind(userId, id).run();
  return json({ ok: true, deleted: result.meta.changes === 1 });
}

async function putNote(request: Request, env: Env, id: string): Promise<Response> {
  validateOrigin(request); const userId = await authenticatedUser(request, env); const note = noteFromUnknown(await boundedJson(request));
  if (note.id !== id) throw new ApiError(400, 'invalid_note');
  const existing = await env.DB.prepare('SELECT id, created_at, updated_at, unit_id, rows_json, layout_json, revision, title, deleted_at FROM notes WHERE user_id = ? AND id = ?').bind(userId, id).first<NoteRow>();
  // 新規の完全な空ノートは従来どおり作らない。一方、既存ノートを空に戻すのは
  // 正規の編集結果なので、行の最後の空block／canvasの0 blockとも更新を許可する。
  if (isEmptyNote(note) && !existing) throw new ApiError(400, 'invalid_note');
  if (existing && existing.revision !== note.revision) return json({ error: 'conflict', note: toPublicNote(existing) }, 409);
  const revision = (existing?.revision || 0) + 1; const updatedAt = new Date().toISOString();
  if (existing) {
    const changed = await env.DB.prepare('UPDATE notes SET updated_at = ?, unit_id = ?, rows_json = ?, layout_json = ?, revision = ?, title = ?, deleted_at = ? WHERE user_id = ? AND id = ? AND revision = ?').bind(updatedAt, note.unitId, JSON.stringify(note.rows), JSON.stringify(note.layout), revision, note.title, note.deletedAt, userId, id, note.revision).run();
    if (changed.meta.changes !== 1) {
      const fresh = await env.DB.prepare('SELECT id, created_at, updated_at, unit_id, rows_json, layout_json, revision, title, deleted_at FROM notes WHERE user_id = ? AND id = ?').bind(userId, id).first<NoteRow>();
      return json({ error: 'conflict', note: fresh ? toPublicNote(fresh) : null }, 409);
    }
  } else {
    // 上限判定をDB文の条件に含める。並列の101件目も保存済みに見せない。
    const inserted = await env.DB.prepare(`
      INSERT INTO notes (id, user_id, created_at, updated_at, unit_id, rows_json, layout_json, revision, title, deleted_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM notes WHERE user_id = ?) < ?
    `).bind(id, userId, note.createdAt, updatedAt, note.unitId, JSON.stringify(note.rows), JSON.stringify(note.layout), revision, note.title, note.deletedAt, userId, MAX_NOTES).run();
    if (inserted.meta.changes !== 1) throw new ApiError(409, 'note_limit');
  }
  return json({ note: { ...note, updatedAt, revision } });
}

async function importNotes(request: Request, env: Env): Promise<Response> {
  validateOrigin(request); const userId = await authenticatedUser(request, env); const body = await boundedJson(request);
  if (!Array.isArray(body.notes) || body.notes.length > MAX_NOTES) throw new ApiError(400, 'invalid_notes');
  const parsedNotes = body.notes.map(noteFromUnknown);
  // 同じノートIDを一回のimportに重ねると、同じbatch内で片方が
  // ON CONFLICT DO NOTHING になり、呼び出し側には上限超過のように見える。
  // 入力の曖昧さは書き込む前に拒否し、importの結果を一意に保つ。
  if (new Set(parsedNotes.map((note) => note.id)).size !== parsedNotes.length) throw new ApiError(400, 'invalid_notes');
  if (encoder.encode(JSON.stringify(parsedNotes)).byteLength > MAX_NOTE_BYTES) throw new ApiError(413, 'notes_too_large');
  const idempotencyKey = stringField(body, 'idempotencyKey', 120);
  if (!/^[a-z0-9_-]{16,120}$/i.test(idempotencyKey)) throw new ApiError(400, 'invalid_request');
  const fingerprint = await sha256(JSON.stringify(parsedNotes));
  const previous = await env.DB.prepare('SELECT fingerprint, response_json FROM note_imports WHERE user_id = ? AND idempotency_key = ?').bind(userId, idempotencyKey).first<ImportRow>();
  if (previous) {
    if (!(await safeEqual(previous.fingerprint, fingerprint))) throw new ApiError(409, 'idempotency_conflict');
    return json(JSON.parse(previous.response_json));
  }

  const existingResults = await env.DB.batch(parsedNotes.map((note) => env.DB.prepare('SELECT id, created_at, updated_at, unit_id, rows_json, layout_json, revision, title, deleted_at FROM notes WHERE user_id = ? AND id = ?').bind(userId, note.id)));
  // 空の新規noteはimportでも作らない。既存IDの空更新だけを残すことで、通信失敗後に
  // 再ログインしても「全部消した」編集結果が古い本文で復活しない。
  const existingById = new Map(parsedNotes.map((note, index) => [note.id, existingResults[index].results[0] as NoteRow | undefined]));
  const notes = parsedNotes.filter((note) => !isEmptyNote(note) || existingById.has(note.id) && Boolean(existingById.get(note.id)));
  const writes: D1PreparedStatement[] = [];
  let imported = 0; let conflicts = 0;
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    const existing = existingById.get(note.id);
    const same = existing && existing.rows_json === JSON.stringify(note.rows) && existing.layout_json === JSON.stringify(note.layout)
      && existing.unit_id === note.unitId && (existing.title ?? null) === note.title && (existing.deleted_at ?? null) === note.deletedAt;
    if (same) continue;
    const targetId = existing ? `note-${(await sha256(`${note.id}\u0000${fingerprint}`)).slice(0, 36)}-conflict` : note.id;
    if (existing) conflicts += 1; else imported += 1;
    writes.push(env.DB.prepare(`
      INSERT INTO notes (id, user_id, created_at, updated_at, unit_id, rows_json, layout_json, revision, title, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(user_id, id) DO NOTHING
    `).bind(targetId, userId, note.createdAt, note.updatedAt, note.unitId, JSON.stringify(note.rows), JSON.stringify(note.layout), note.title, note.deletedAt));
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM notes WHERE user_id = ?').bind(userId).first<{ count: number }>();
  if ((count?.count || 0) + writes.length > MAX_NOTES) throw new ApiError(409, 'note_limit');
  const response = { imported, conflicts };
  // ノート書込みと完了印を同一のD1 batch（原子的な一括処理）に置く。
  // 途中で失敗すれば両方とも残らず、成功後の再試行だけが既完了として読める。
  const marker = env.DB.prepare('INSERT INTO note_imports (user_id, idempotency_key, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, idempotencyKey, fingerprint, JSON.stringify(response), new Date().toISOString());
  try {
    await env.DB.batch([...writes, marker]);
  } catch (error) {
    // 同じidempotency keyが並行に届いたとき、先行要求がbatchを完了済みなら
    // 一意制約エラーを500にせず、先行結果を返す。
    const completed = await env.DB.prepare('SELECT fingerprint, response_json FROM note_imports WHERE user_id = ? AND idempotency_key = ?').bind(userId, idempotencyKey).first<ImportRow>();
    if (completed) {
      if (!(await safeEqual(completed.fingerprint, fingerprint))) throw new ApiError(409, 'idempotency_conflict');
      return json(JSON.parse(completed.response_json));
    }
    if (error instanceof Error && error.message.includes('note_limit')) throw new ApiError(409, 'note_limit');
    throw error;
  }
  return json(response);
}

async function listConversionProfile(request: Request, env: Env): Promise<Response> {
  const userId = await authenticatedUser(request, env);
  const row = await env.DB.prepare('SELECT dictionary_json, manual_json, revision, updated_at FROM conversion_profiles WHERE user_id = ?').bind(userId).first<ProfileRow>();
  return json({ profile: profileFromRow(row) });
}

async function putConversionProfile(request: Request, env: Env): Promise<Response> {
  validateOrigin(request); const userId = await authenticatedUser(request, env); const body = await boundedJson(request);
  const dictionary = dictionaryFromUnknown(body.dictionary);
  const manual = manualFromUnknown(body.manual);
  const requestedRevision = body.revision;
  if (typeof requestedRevision !== 'number' || !Number.isSafeInteger(requestedRevision) || requestedRevision < 0) throw new ApiError(400, 'invalid_dictionary');
  const revision = requestedRevision;
  const idempotencyKey = stringField(body, 'idempotencyKey', 120);
  if (!/^[a-z0-9_-]{16,120}$/i.test(idempotencyKey)) throw new ApiError(400, 'invalid_request');
  const payload = { dictionary, manual };
  const fingerprint = await sha256(JSON.stringify(payload));
  const previous = await env.DB.prepare('SELECT fingerprint, response_json FROM conversion_profile_updates WHERE user_id = ? AND idempotency_key = ?').bind(userId, idempotencyKey).first<ProfileUpdateRow>();
  if (previous) {
    if (!(await safeEqual(previous.fingerprint, fingerprint))) throw new ApiError(409, 'idempotency_conflict');
    return json(JSON.parse(previous.response_json));
  }
  const existing = await env.DB.prepare('SELECT dictionary_json, manual_json, revision, updated_at FROM conversion_profiles WHERE user_id = ?').bind(userId).first<ProfileRow>();
  const current = profileFromRow(existing);
  const sameAsCurrent = JSON.stringify(current.dictionary) === JSON.stringify(dictionary) && JSON.stringify(current.manual) === JSON.stringify(manual);
  if (current.revision !== revision && !sameAsCurrent) return json({ error: 'conflict', profile: current }, 409);

  let response: { profile: PublicConversionProfile };
  if (sameAsCurrent) {
    response = { profile: current };
  } else {
    const now = new Date().toISOString();
    if (existing) {
      const updated = await env.DB.prepare('UPDATE conversion_profiles SET dictionary_json = ?, manual_json = ?, revision = ?, updated_at = ? WHERE user_id = ? AND revision = ?')
        .bind(JSON.stringify(dictionary), JSON.stringify(manual), revision + 1, now, userId, revision).run();
      if (updated.meta.changes !== 1) {
        const fresh = await env.DB.prepare('SELECT dictionary_json, manual_json, revision, updated_at FROM conversion_profiles WHERE user_id = ?').bind(userId).first<ProfileRow>();
        return json({ error: 'conflict', profile: profileFromRow(fresh) }, 409);
      }
    } else {
      try {
        await env.DB.prepare('INSERT INTO conversion_profiles (user_id, dictionary_json, manual_json, revision, updated_at) VALUES (?, ?, ?, 1, ?)')
          .bind(userId, JSON.stringify(dictionary), JSON.stringify(manual), now).run();
      } catch {
        const fresh = await env.DB.prepare('SELECT dictionary_json, manual_json, revision, updated_at FROM conversion_profiles WHERE user_id = ?').bind(userId).first<ProfileRow>();
        return json({ error: 'conflict', profile: profileFromRow(fresh) }, 409);
      }
    }
    response = { profile: { dictionary, manual, revision: revision + 1, updatedAt: now } };
  }
  try {
    await env.DB.prepare('INSERT INTO conversion_profile_updates (user_id, idempotency_key, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, idempotencyKey, fingerprint, JSON.stringify(response), new Date().toISOString()).run();
  } catch {
    const completed = await env.DB.prepare('SELECT fingerprint, response_json FROM conversion_profile_updates WHERE user_id = ? AND idempotency_key = ?').bind(userId, idempotencyKey).first<ProfileUpdateRow>();
    if (!completed || !(await safeEqual(completed.fingerprint, fingerprint))) throw new ApiError(409, 'idempotency_conflict');
    return json(JSON.parse(completed.response_json));
  }
  return json(response);
}

function reviewText(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string') {
    if (required) throw new ApiError(400, 'invalid_review');
    return '';
  }
  const text = value.replace(/\u0000/g, '').trim();
  if ((required && !text) || text.length > max) throw new ApiError(400, 'invalid_review');
  return text;
}

function reviewRequestFromUnknown(value: Record<string, unknown>): ReviewRequest {
  const noteId = stringField(value, 'noteId', 120);
  if (!/^note-[a-z0-9-]{8,120}(?:-conflict)?$/i.test(noteId)) throw new ApiError(400, 'invalid_review');
  const noteUpdatedAt = reviewText(value.noteUpdatedAt, 40, true);
  if (Number.isNaN(Date.parse(noteUpdatedAt))) throw new ApiError(400, 'invalid_review');
  const problem = reviewText(value.problem, MAX_REVIEW_PROBLEM_CHARS, true);
  const conditions = reviewText(value.conditions, MAX_REVIEW_CONDITIONS_CHARS);
  const reviewKind = value.reviewKind === 'hint' || value.reviewKind === 'review' ? value.reviewKind : null;
  const mode = value.mode === 'single' || value.mode === 'pipeline' ? value.mode : null;
  const idempotencyKey = reviewText(value.idempotencyKey, 120, true);
  if (!reviewKind || !mode || !/^[a-z0-9_-]{16,120}$/i.test(idempotencyKey) || !Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > MAX_REVIEW_BLOCKS) throw new ApiError(400, 'invalid_review');
  const blocks: ReviewBlock[] = [];
  const blockIds = new Set<string>();
  for (const raw of value.blocks) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'invalid_review');
    const block = raw as Record<string, unknown>;
    const id = reviewText(block.id, 120, true);
    const latex = reviewText(block.latex, MAX_REVIEW_BLOCK_CHARS, true);
    if (!/^[a-z][a-z0-9:_-]{0,119}$/i.test(id) || blockIds.has(id)) throw new ApiError(400, 'invalid_review');
    blockIds.add(id); blocks.push({ id, latex });
  }
  if (encoder.encode(JSON.stringify({ noteId, noteUpdatedAt, problem, conditions, blocks })).byteLength > MAX_BODY_BYTES - 4_096) throw new ApiError(413, 'review_too_large');
  return { noteId, noteUpdatedAt, problem, conditions, reviewKind, mode, blocks, idempotencyKey };
}

function boundedStringList(value: unknown, max = 4, itemMax = 400): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\u0000/g, '').trim()).filter(Boolean).slice(0, max).map((item) => item.slice(0, itemMax));
}

function boundedConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function reviewCorrections(value: unknown, allowedIds: Set<string>): Array<{ blockId: string | null; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const entry = raw as Record<string, unknown>;
    const text = typeof entry.text === 'string' ? entry.text.replace(/\u0000/g, '').trim().slice(0, 600) : '';
    const blockId = typeof entry.blockId === 'string' && allowedIds.has(entry.blockId) ? entry.blockId : null;
    return text ? [{ blockId, text }] : [];
  });
}

function normalizeReviewCard(value: unknown, allowedIds: Set<string>): ReviewCard {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const nextStep = typeof item.nextStep === 'string' ? item.nextStep.replace(/\u0000/g, '').trim().slice(0, 600) : '';
  if (!nextStep) throw new ApiError(502, 'review_invalid_response');
  return { strengths: boundedStringList(item.strengths), corrections: reviewCorrections(item.corrections, allowedIds), nextStep, confidence: boundedConfidence(item.confidence) };
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('Content-Length') || '0') > MAX_OPENAI_RESPONSE_BYTES) throw new ApiError(502, 'review_response_too_large');
  if (!response.body) throw new ApiError(502, 'review_invalid_response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OPENAI_RESPONSE_BYTES) throw new ApiError(502, 'review_response_too_large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(decoder.decode(all)); }
  catch { throw new ApiError(502, 'review_invalid_response'); }
}

function responseText(payload: unknown): { text: string; refused: boolean } {
  if (!payload || typeof payload !== 'object') return { text: '', refused: false };
  const item = payload as Record<string, unknown>;
  if (typeof item.output_text === 'string') return { text: item.output_text, refused: false };
  if (!Array.isArray(item.output)) return { text: '', refused: false };
  for (const output of item.output) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) continue;
    const content = (output as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const record = part as Record<string, unknown>;
        if (record.type === 'refusal') return { text: '', refused: true };
        if (typeof record.text === 'string') return { text: record.text, refused: false };
      }
    }
  }
  return { text: '', refused: false };
}

function reviewStageSchema(stage: ReviewStage): Record<string, unknown> {
  const base = { type: 'object', additionalProperties: false };
  const confidence = { type: 'number' };
  const strengths = { type: 'array', items: { type: 'string' } };
  const corrections = { type: 'array', items: { type: 'object', additionalProperties: false, properties: { blockId: { type: ['string', 'null'] }, text: { type: 'string' } }, required: ['blockId', 'text'] } };
  if (stage === 'independent_solver') return { ...base, properties: { referenceSteps: strengths, checkpoints: strengths, confidence }, required: ['referenceSteps', 'checkpoints', 'confidence'] };
  if (stage === 'solution_auditor') return { ...base, properties: { strengths, corrections, firstMismatchBlockId: { type: ['string', 'null'] }, issueTypes: strengths, hintDirection: { type: 'string' }, correctSummary: { type: 'string' }, confidence, needsFalsifier: { type: 'boolean' } }, required: ['strengths', 'corrections', 'firstMismatchBlockId', 'issueTypes', 'hintDirection', 'correctSummary', 'confidence', 'needsFalsifier'] };
  if (stage === 'falsifier') return { ...base, properties: { verdict: { type: 'string' }, disagreement: { type: 'boolean' }, strengths, corrections, nextStep: { type: 'string' }, confidence }, required: ['verdict', 'disagreement', 'strengths', 'corrections', 'nextStep', 'confidence'] };
  return { ...base, properties: { strengths, corrections, nextStep: { type: 'string' }, confidence }, required: ['strengths', 'corrections', 'nextStep', 'confidence'] };
}

function responseUsage(payload: unknown): ReviewUsage {
  const usage = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).usage : null;
  const record = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : {};
  const integer = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  return { inputTokens: integer(record.input_tokens), outputTokens: integer(record.output_tokens), totalTokens: integer(record.total_tokens) };
}

async function responseJson(env: Env, stage: ReviewStage, input: Record<string, unknown>): Promise<ReviewResponse> {
  if (!env.OPENAI_API_KEY) throw new ApiError(503, 'review_not_configured');
  const schema = reviewStageSchema(stage);
  const stageInstruction = stage === 'solution_auditor'
    ? 'Treat a different correct approach as correct. Call out only the first block that is no longer mathematically derivable from prior blocks and stated conditions. Never put final values, reference formulas, or worked solution steps in hintDirection or correctSummary.'
    : stage === 'tutor'
      ? 'Use only the supplied safe handoff. Never reconstruct or reveal a full solution, reference formula, or final answer.'
      : 'Do not reveal a full chain of thought.';
  let response: Response;
  const startedAt = Date.now();
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        store: false,
        text: { format: { type: 'json_schema', name: `shikitype_${stage}`, strict: true, schema } },
        input: [{ role: 'developer', content: [{ type: 'input_text', text: `You are the ${stage} stage of a Japanese high-school mathematics review pipeline. Return only the requested JSON. Never reveal hidden chain-of-thought. Use concise Japanese. ${stageInstruction}` }] }, { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] }],
      }),
    });
  } catch {
    throw new ApiError(503, 'review_unavailable');
  }
  if (!response.ok) throw new ApiError(response.status === 401 || response.status === 403 ? 503 : 502, 'review_unavailable');
  const payload = await boundedResponseJson(response);
  const extracted = responseText(payload);
  if (extracted.refused) throw new ApiError(422, 'review_refused');
  let parsed: unknown;
  try { parsed = JSON.parse(extracted.text); }
  catch { throw new ApiError(502, 'review_invalid_response'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(502, 'review_invalid_response');
  return { output: parsed as Record<string, unknown>, usage: responseUsage(payload), durationMs: Date.now() - startedAt };
}

async function insertReviewStage(env: Env, runId: string, stage: ReviewStage, inputScope: string, output: unknown, usage: ReviewUsage | null = null, durationMs: number | null = null): Promise<void> {
  await env.DB.prepare('INSERT INTO review_stages (id, run_id, stage, input_scope, output_json, input_tokens, output_tokens, total_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`rvs_${crypto.randomUUID()}`, runId, stage, inputScope, JSON.stringify(output), usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.totalTokens ?? null, durationMs, new Date().toISOString()).run();
}

async function executeReviewPipeline(env: Env, runId: string, review: ReviewRequest): Promise<{ card: ReviewCard; stages: Array<{ stage: ReviewStage; inputScope: string; skipped?: boolean; reason?: string }> }> {
  const allowedIds = new Set(review.blocks.map((block) => block.id));
  const stages: Array<{ stage: ReviewStage; inputScope: string; skipped?: boolean; reason?: string }> = [];
  const write = async (stage: ReviewStage, inputScope: string, response: ReviewResponse) => {
    await insertReviewStage(env, runId, stage, inputScope, response.output, response.usage, response.durationMs);
    stages.push({ stage, inputScope });
  };
  if (review.mode === 'single') {
    const response = await responseJson(env, 'single', { task: review.reviewKind, problem: review.problem, conditions: review.conditions, studentBlocks: review.blocks, output: 'Return strengths, corrections, nextStep, confidence.' });
    const card = normalizeReviewCard(response.output, allowedIds);
    await insertReviewStage(env, runId, 'single', 'problem_conditions_and_student_blocks', card, response.usage, response.durationMs);
    stages.push({ stage: 'single', inputScope: 'problem_conditions_and_student_blocks' });
    return { card, stages };
  }

  // Contract: independent_solver gets no `studentBlocks` field, ever.
  const solverResponse = await responseJson(env, 'independent_solver', { task: 'Solve independently within Japanese high-school mathematics.', problem: review.problem, conditions: review.conditions, output: 'Return referenceSteps, checkpoints, confidence.' });
  const reference = { referenceSteps: boundedStringList(solverResponse.output.referenceSteps, 8), checkpoints: boundedStringList(solverResponse.output.checkpoints, 8), confidence: boundedConfidence(solverResponse.output.confidence) };
  await insertReviewStage(env, runId, 'independent_solver', 'problem_and_conditions', reference, solverResponse.usage, solverResponse.durationMs);
  stages.push({ stage: 'independent_solver', inputScope: 'problem_and_conditions' });

  const auditorResponse = await responseJson(env, 'solution_auditor', {
    task: review.reviewKind,
    reference,
    studentBlocks: review.blocks,
    auditRule: 'Do not mark a different method wrong merely because it differs from the reference. An error is the first block that can no longer be mathematically derived from the prior blocks and stated conditions.',
    safeHandoffRule: 'hintDirection and correctSummary must not contain a final answer, a reference formula, or a worked solution.',
    output: 'Return strengths, corrections with blockId, firstMismatchBlockId, issueTypes, hintDirection, correctSummary, confidence, needsFalsifier.',
  });
  const diagnosis = {
    strengths: boundedStringList(auditorResponse.output.strengths),
    corrections: reviewCorrections(auditorResponse.output.corrections, allowedIds),
    firstMismatchBlockId: typeof auditorResponse.output.firstMismatchBlockId === 'string' && allowedIds.has(auditorResponse.output.firstMismatchBlockId) ? auditorResponse.output.firstMismatchBlockId : null,
    issueTypes: boundedStringList(auditorResponse.output.issueTypes, 4, 80),
    hintDirection: typeof auditorResponse.output.hintDirection === 'string' ? auditorResponse.output.hintDirection.slice(0, 400) : '',
    correctSummary: typeof auditorResponse.output.correctSummary === 'string' ? auditorResponse.output.correctSummary.slice(0, 400) : '',
    confidence: boundedConfidence(auditorResponse.output.confidence),
    needsFalsifier: auditorResponse.output.needsFalsifier === true,
  };
  await insertReviewStage(env, runId, 'solution_auditor', 'reference_solution_and_student_blocks', diagnosis, auditorResponse.usage, auditorResponse.durationMs);
  stages.push({ stage: 'solution_auditor', inputScope: 'reference_solution_and_student_blocks' });

  // Contract: pipeline mode always runs all four roles. The falsifier sees summaries only,
  // never the complete student answer.
  const falsifierResponse = await responseJson(env, 'falsifier', { task: 'Try to refute the audit without inventing facts.', reference, diagnosis, output: 'Return verdict, disagreement, strengths, corrections, nextStep, confidence.' });
  const falsifier = falsifierResponse.output;
  const verified = { ...diagnosis, strengths: boundedStringList(falsifier.strengths).length ? boundedStringList(falsifier.strengths) : diagnosis.strengths, corrections: reviewCorrections(falsifier.corrections, allowedIds).length ? reviewCorrections(falsifier.corrections, allowedIds) : diagnosis.corrections, confidence: boundedConfidence(falsifier.confidence) };
  await insertReviewStage(env, runId, 'falsifier', 'reference_and_audit_summary', { verdict: typeof falsifier.verdict === 'string' ? falsifier.verdict.slice(0, 300) : '', disagreement: falsifier.disagreement === true, ...verified }, falsifierResponse.usage, falsifierResponse.durationMs);
  stages.push({ stage: 'falsifier', inputScope: 'reference_and_audit_summary' });

  // Contract: tutor is deliberately denied the original problem, reference solution, full answer,
  // and the auditor's full record. Real API leakage-rate evaluation belongs in a separate eval,
  // never this regular user-facing request path; mocks assert this fixed handoff shape.
  const safeHandoff = { blockId: verified.firstMismatchBlockId, issueTypes: verified.issueTypes, hintDirection: verified.hintDirection, correctSummary: verified.correctSummary, strengths: verified.strengths };
  const tutorResponse = await responseJson(env, 'tutor', { task: review.reviewKind, safeHandoff, output: 'Return strengths, corrections, nextStep, confidence. Give the smallest useful hint; do not reveal a full solution or final answer.' });
  const card = normalizeReviewCard(tutorResponse.output, allowedIds);
  await insertReviewStage(env, runId, 'tutor', 'safe_audit_handoff_only', card, tutorResponse.usage, tutorResponse.durationMs);
  stages.push({ stage: 'tutor', inputScope: 'safe_audit_handoff_only' });
  return { card, stages };
}

async function createReview(request: Request, env: Env): Promise<Response> {
  validateOrigin(request); const userId = await authenticatedUser(request, env); const review = reviewRequestFromUnknown(await boundedJson(request));
  const note = await env.DB.prepare('SELECT id, updated_at FROM notes WHERE user_id = ? AND id = ?').bind(userId, review.noteId).first<{ id: string; updated_at: string }>();
  if (!note) throw new ApiError(404, 'note_not_found');
  // 見直す対象はサーバに保存済みの同一snapshotだけに限定する。編集中の古い
  // ブロックへ結果を紐付けないため、クライアントは同期成功後のupdatedAtを送る。
  if (note.updated_at !== review.noteUpdatedAt) throw new ApiError(409, 'note_stale');
  const fingerprint = await sha256(JSON.stringify({ noteId: review.noteId, noteUpdatedAt: review.noteUpdatedAt, problem: review.problem, conditions: review.conditions, reviewKind: review.reviewKind, mode: review.mode, blocks: review.blocks }));
  const existing = await env.DB.prepare('SELECT id, status, fingerprint, result_json, error_code FROM review_runs WHERE user_id = ? AND idempotency_key = ?').bind(userId, review.idempotencyKey).first<{ id: string; status: string; fingerprint: string; result_json: string | null; error_code: string | null }>();
  if (existing) {
    if (!(await safeEqual(existing.fingerprint, fingerprint))) throw new ApiError(409, 'idempotency_conflict');
    if (existing.status === 'completed' && existing.result_json) return json(JSON.parse(existing.result_json));
    if (existing.status === 'running') throw new ApiError(409, 'review_in_progress');
    throw new ApiError(503, existing.error_code || 'review_failed');
  }
  await rateLimit(request, env, 'review');
  const running = await env.DB.prepare("SELECT COUNT(*) AS count FROM review_runs WHERE user_id = ? AND status = 'running'").bind(userId).first<{ count: number }>();
  if ((running?.count || 0) >= 1) throw new ApiError(429, 'review_busy');
  const runId = `rev_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO review_runs (id, user_id, note_id, note_updated_at, snapshot_json, problem_text, conditions_text, review_kind, mode, status, idempotency_key, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(runId, userId, review.noteId, review.noteUpdatedAt, JSON.stringify(review.blocks), review.problem, review.conditions, review.reviewKind, review.mode, 'running', review.idempotencyKey, fingerprint, now).run();
  try {
    const executed = await executeReviewPipeline(env, runId, review);
    const result = { runId, noteId: review.noteId, noteUpdatedAt: review.noteUpdatedAt, reviewKind: review.reviewKind, mode: review.mode, card: executed.card, stages: executed.stages, createdAt: now };
    await env.DB.prepare("UPDATE review_runs SET status = 'completed', result_json = ?, completed_at = ? WHERE id = ? AND user_id = ?").bind(JSON.stringify(result), new Date().toISOString(), runId, userId).run();
    return json(result, 201);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'review_failed';
    await env.DB.prepare("UPDATE review_runs SET status = 'failed', error_code = ?, completed_at = ? WHERE id = ? AND user_id = ?").bind(code, new Date().toISOString(), runId, userId).run();
    throw error;
  }
}

async function listReviews(request: Request, env: Env, noteId: string): Promise<Response> {
  const userId = await authenticatedUser(request, env);
  const result = await env.DB.prepare("SELECT id, note_id, note_updated_at, snapshot_json, review_kind, mode, status, result_json, error_code, created_at, completed_at FROM review_runs WHERE user_id = ? AND note_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 12").bind(userId, noteId).all<ReviewRunRow>();
  return json({ reviews: result.results.map((row) => ({ runId: row.id, noteId: row.note_id, noteUpdatedAt: row.note_updated_at, reviewKind: row.review_kind, mode: row.mode, createdAt: row.created_at, completedAt: row.completed_at, snapshot: JSON.parse(row.snapshot_json), result: row.result_json ? JSON.parse(row.result_json) : null })) });
}

// 見直し実行中の進行状況だけを軽量に返す。executeReviewPipeline()は各段階が終わるたびに
// review_stagesへ即insertしているため（同一requestの完了を待たずD1へ反映される）、
// 別requestとして送るこのpollingは、パイプラインを止めずに「今どこまで終わったか」を読める。
// SSE化やバックグラウンド実行への作り替えはせず、既存の逐次insertへ相乗りするだけに留めた。
async function reviewStatus(request: Request, env: Env): Promise<Response> {
  const userId = await authenticatedUser(request, env);
  const key = new URL(request.url).searchParams.get('key') || '';
  if (!key || key.length > 200) throw new ApiError(400, 'invalid_request');
  const run = await env.DB.prepare('SELECT id, status, result_json, error_code FROM review_runs WHERE user_id = ? AND idempotency_key = ?').bind(userId, key).first<{ id: string; status: string; result_json: string | null; error_code: string | null }>();
  if (!run) return json({ status: 'pending', stages: [] });
  const stagesResult = await env.DB.prepare('SELECT stage, input_scope, duration_ms FROM review_stages WHERE run_id = ? ORDER BY created_at ASC').bind(run.id).all<{ stage: string; input_scope: string; duration_ms: number | null }>();
  const stages = stagesResult.results.map((row) => ({ stage: row.stage, durationMs: row.duration_ms, skipped: row.input_scope === 'skipped_by_stage_conditions' }));
  if (run.status === 'completed' && run.result_json) return json({ status: 'completed', stages, result: JSON.parse(run.result_json) });
  if (run.status === 'failed') return json({ status: 'failed', stages, error: run.error_code || 'review_failed' });
  return json({ status: 'running', stages });
}

async function api(request: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/auth/config' && request.method === 'GET') return handleGoogleConfig(request, env);
  if (path === '/api/auth/signup' && request.method === 'POST') return signup(request, env);
  if (path === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/auth/recover' && request.method === 'POST') return recover(request, env);
  if (path === '/api/auth/google' && request.method === 'POST') return handleGoogleLogin(request, env);
  if (path === '/api/auth/me' && request.method === 'GET') {
    let userId: string;
    try { userId = await authenticatedUser(request, env); }
    catch (error) { if (error instanceof ApiError && error.status === 401) return json({ user: null }); throw error; }
    const user = await env.DB.prepare('SELECT id, login_id, password_hash, password_salt, recovery_hash, google_sub, google_name FROM users WHERE id = ?').bind(userId).first<UserRow>();
    if (!user) return json({ user: null });
    return json({ user: publicAccount(user) });
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    validateOrigin(request); const token = getCookies(request).get('__Host-shikitype_session');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(`${token}\u0000${env.AUTH_PEPPER}`)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }
  if (path === '/api/notes' && request.method === 'GET') return listNotes(request, env);
  if (path === '/api/notes/import' && request.method === 'POST') return importNotes(request, env);
  if (path === '/api/conversion-profile' && request.method === 'GET') return listConversionProfile(request, env);
  if (path === '/api/conversion-profile' && request.method === 'PUT') return putConversionProfile(request, env);
  if (path === '/api/reviews' && request.method === 'POST') return createReview(request, env);
  if (path === '/api/reviews/status' && request.method === 'GET') return reviewStatus(request, env);
  const reviewMatch = /^\/api\/notes\/([^/]+)\/reviews$/.exec(path);
  if (reviewMatch && request.method === 'GET') return listReviews(request, env, decodeURIComponent(reviewMatch[1]));
  const match = /^\/api\/notes\/([^/]+)$/.exec(path);
  if (match && request.method === 'PUT') return putNote(request, env, decodeURIComponent(match[1]));
  if (match && request.method === 'DELETE') return deleteNote(request, env, decodeURIComponent(match[1]));
  throw new ApiError(404, 'not_found');
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return addSecurityHeaders(await api(request, env, url.pathname));
      return addSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      if (error instanceof ApiError) return addSecurityHeaders(json({ error: error.code }, error.status));
      console.error(JSON.stringify({ message: 'request_failed', path: url.pathname, error: error instanceof Error ? error.message : 'unknown' }));
      return addSecurityHeaders(json({ error: 'internal_error' }, 500));
    }
  },
} satisfies ExportedHandler<Env>;
