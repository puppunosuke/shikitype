import { describe, expect, it } from 'vitest';
import { GoogleTokenError, verifyGoogleIdToken } from '../src/google-id-token';

const encoder = new TextEncoder();

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signedGoogleToken(overrides: Record<string, unknown> = {}): Promise<{ token: string; jwks: JsonWebKey[] }> {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'test-google-key', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: 'https://accounts.google.com', aud: 'shikitype-client', sub: 'google-user-123',
    exp: now + 3600, iat: now, email: 'student@example.com', email_verified: true,
    name: '受験生', ...overrides,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, encoder.encode(signingInput)));
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  return { token: `${signingInput}.${base64Url(signature)}`, jwks: [{ ...publicJwk, kid: 'test-google-key', alg: 'RS256', use: 'sig' }] };
}

describe('Google ID token verification', () => {
  it('accepts a correctly signed Google ID token and its required claims', async () => {
    const { token, jwks } = await signedGoogleToken();
    await expect(verifyGoogleIdToken(token, 'shikitype-client', { jwks })).resolves.toEqual({
      sub: 'google-user-123', email: 'student@example.com', name: '受験生', picture: null,
    });
  });

  it.each([
    ['aud', { aud: 'another-client' }],
    ['iss', { iss: 'https://attacker.example' }],
    ['exp', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['email_verified', { email_verified: false }],
  ])('rejects a signed Google ID token with an invalid %s claim', async (_claim, overrides) => {
    const { token, jwks } = await signedGoogleToken(overrides);
    await expect(verifyGoogleIdToken(token, 'shikitype-client', { jwks })).rejects.toBeInstanceOf(GoogleTokenError);
  });
});
