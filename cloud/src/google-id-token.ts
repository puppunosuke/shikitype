const encoder = new TextEncoder();
const decoder = new TextDecoder();
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_JWKS_CACHE_TTL_SECONDS = 3600;

export type GoogleJwk = JsonWebKey & { kid?: string; kty?: string; alg?: string; use?: string };
export type GoogleIdentity = { sub: string; email: string; name: string | null; picture: string | null };

export class GoogleTokenError extends Error {}

function invalidToken(): never { throw new GoogleTokenError('google_verification_failed'); }

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalidToken();
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - value.length % 4) % 4)}`;
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return invalidToken();
  }
}

function parseJwtPart(part: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(base64UrlToBytes(part)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidToken();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GoogleTokenError) throw error;
    return invalidToken();
  }
}

async function loadGoogleJwks(force = false): Promise<GoogleJwk[]> {
  const cache = caches.default;
  const cacheKey = new Request(GOOGLE_JWKS_URL);
  if (!force) {
    const cached = await cache.match(cacheKey);
    if (cached?.ok) {
      try {
        const body: unknown = await cached.json();
        if (body && typeof body === 'object' && Array.isArray((body as { keys?: unknown }).keys)) return (body as { keys: GoogleJwk[] }).keys;
      } catch { /* キャッシュ破損時は公式JWKSを再取得する */ }
    }
  }
  let response: Response;
  try {
    response = await fetch(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' } });
  } catch {
    return invalidToken();
  }
  if (!response.ok) invalidToken();
  let body: unknown;
  try { body = await response.clone().json(); } catch { return invalidToken(); }
  if (!body || typeof body !== 'object' || !Array.isArray((body as { keys?: unknown }).keys)) invalidToken();
  const maxAge = Number(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1] || GOOGLE_JWKS_CACHE_TTL_SECONDS);
  const ttl = Math.max(60, Math.min(maxAge, 86_400));
  await cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } }));
  return (body as { keys: GoogleJwk[] }).keys;
}

export async function verifyGoogleIdToken(token: string, clientId: string, options: { jwks?: GoogleJwk[] } = {}): Promise<GoogleIdentity> {
  if (!clientId || typeof token !== 'string' || token.length < 32 || token.length > 10_000) invalidToken();
  const [headerPart, payloadPart, signaturePart, extra] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart || extra) invalidToken();
  const header = parseJwtPart(headerPart);
  const payload = parseJwtPart(payloadPart);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) invalidToken();
  let keys = options.jwks || await loadGoogleJwks();
  let jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
  if (!jwk && !options.jwks) {
    keys = await loadGoogleJwks(true);
    jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
  }
  if (!jwk) invalidToken();
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch { return invalidToken(); }
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(signaturePart), encoder.encode(`${headerPart}.${payloadPart}`)))) invalidToken();
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId) || (Array.isArray(payload.aud) && payload.azp !== clientId)) invalidToken();
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') invalidToken();
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now) invalidToken();
  if (typeof payload.nbf === 'number' && payload.nbf > now + 300) invalidToken();
  if (typeof payload.iat === 'number' && payload.iat > now + 300) invalidToken();
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) invalidToken();
  if (payload.email_verified !== true || typeof payload.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email) || payload.email.length > 320) invalidToken();
  return {
    sub: payload.sub,
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name.slice(0, 80) : null,
    picture: typeof payload.picture === 'string' && payload.picture.startsWith('https://') ? payload.picture.slice(0, 1000) : null,
  };
}
