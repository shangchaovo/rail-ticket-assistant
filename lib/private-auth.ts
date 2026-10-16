/** Private owner authentication. No platform imports, credentials, or environment side effects. */
export const SESSION_COOKIE = 'rail_session';
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const ATTEMPT_WINDOW_SECONDS = 10 * 60;
export const MAX_ATTEMPTS = 6;
export const LOGIN_ATTEMPT_SQL = `INSERT INTO auth_attempts (ip_hash, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(ip_hash, window_start) DO UPDATE SET attempts=auth_attempts.attempts+1 WHERE auth_attempts.attempts < ${MAX_ATTEMPTS} RETURNING attempts`;

export type PrivateAuthEnv = {
  RAIL_AUTH_MODE?: string;
  RAIL_OWNER_ID?: string;
  RAIL_PASSWORD_HASH?: string;
  RAIL_SESSION_SECRET?: string;
};
export type PrivateAuthConfig = { ownerId: string; passwordHash: string; sessionSecret: string };
export type PrivateSession = { v: 1; sub: string; iat: number; exp: number };
const encoder = new TextEncoder();
export const PASSWORD_ITERATIONS = 100_000;
const passwordHashPattern = /^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/i;

export function authMode(env: PrivateAuthEnv): 'private' | 'sites' | 'invalid' {
  if (env.RAIL_AUTH_MODE === 'private') return 'private';
  if (env.RAIL_AUTH_MODE === undefined || env.RAIL_AUTH_MODE === 'sites') return 'sites';
  return 'invalid';
}

export function privateConfig(env: PrivateAuthEnv): PrivateAuthConfig | null {
  if (authMode(env) !== 'private'
    || typeof env.RAIL_OWNER_ID !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.RAIL_OWNER_ID)
    || typeof env.RAIL_PASSWORD_HASH !== 'string'
    || !(/^[0-9a-f]{64}$/i.test(env.RAIL_PASSWORD_HASH) || passwordHashPattern.test(env.RAIL_PASSWORD_HASH))
    || typeof env.RAIL_SESSION_SECRET !== 'string'
    || env.RAIL_SESSION_SECRET.length < 32) return null;
  return { ownerId: env.RAIL_OWNER_ID, passwordHash: env.RAIL_PASSWORD_HASH.toLowerCase(), sessionSecret: env.RAIL_SESSION_SECRET };
}

export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || /[\\\u0000-\u0020\u007f]/.test(value)) return '/';
  try {
    const base = 'https://rail-auth.invalid';
    const url = new URL(value, base);
    if (url.origin !== base) return '/';
    let decoded = url.pathname;
    for (let i = 0; i < 2; i++) decoded = decodeURIComponent(decoded);
    if (decoded.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(decoded)) return '/';
    if (['/login', '/signin-with-chatgpt', '/signout-with-chatgpt', '/callback'].includes(decoded.replace(/\/+$/, ''))
      || decoded === '/api/auth' || decoded.startsWith('/api/auth/')) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return '/'; }
}

export function sameOrigin(request: Request): boolean {
  try { return request.headers.get('Origin') === new URL(request.url).origin; }
  catch { return false; }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}

export async function verifyPassword(password: unknown, config: PrivateAuthConfig): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 1024) return false;
  if (passwordHashPattern.test(config.passwordHash)) {
    const [, , salt, expected] = config.passwordHash.split('$');
    return constantTimeEqual(await passwordDigest(password, salt), expected);
  }
  // Read existing deployments during migration; provisioning only creates PBKDF2.
  if (!/^[0-9a-f]{64}$/i.test(config.passwordHash)) return false;
  return constantTimeEqual(await sha256Hex(password), config.passwordHash);
}
async function passwordDigest(password: string, saltHex: string): Promise<string> {
  const salt = Uint8Array.from(saltHex.match(/../g)!, value => parseInt(value, 16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS }, key, 256);
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function createPasswordHash(password: string): Promise<string> {
  if (!password || password.length > 1024) throw new Error('Invalid password');
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${salt}$${await passwordDigest(password, salt)}`;
}

function base64Url(data: Uint8Array): string {
  return btoa(Array.from(data, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid session');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), char => char.charCodeAt(0));
  if (base64Url(bytes) !== value) throw new Error('Invalid session');
  return bytes;
}
async function signingKey(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createPrivateSession(config: PrivateAuthConfig, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload: PrivateSession = { v: 1, sub: config.ownerId, iat: nowSeconds, exp: nowSeconds + SESSION_SECONDS };
  const encoded = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(config.sessionSecret), encoder.encode(encoded));
  return `${encoded}.${base64Url(new Uint8Array(signature))}`;
}

export async function verifyPrivateSession(token: string, config: PrivateAuthConfig, nowSeconds = Math.floor(Date.now() / 1000)): Promise<PrivateSession | null> {
  if (typeof token !== 'string' || token.length > 2048) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const payloadBytes = decodeBase64Url(parts[0]);
    const signature = decodeBase64Url(parts[1]);
    if (signature.length !== 32 || !await crypto.subtle.verify('HMAC', await signingKey(config.sessionSecret), signature, encoder.encode(parts[0]))) return null;
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)) as Partial<PrivateSession>;
    if (payload.v !== 1 || payload.sub !== config.ownerId
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.iat! > nowSeconds || payload.exp! <= nowSeconds
      || payload.exp! - payload.iat! !== SESSION_SECONDS) return null;
    return payload as PrivateSession;
  } catch { return null; }
}

export async function readPrivateSession(cookieHeader: string | null, config: PrivateAuthConfig | null, nowSeconds = Math.floor(Date.now() / 1000)): Promise<PrivateSession | null> {
  if (!cookieHeader || !config) return null;
  const entries = cookieHeader.split(';').map(value => value.trim()).filter(value => value.startsWith(`${SESSION_COOKIE}=`));
  if (entries.length !== 1) return null;
  return verifyPrivateSession(entries[0].slice(SESSION_COOKIE.length + 1), config, nowSeconds);
}

export function sessionCookie(token: string, requestUrl: string, clear = false): string {
  const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${clear ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}${secure}`;
}

export function attemptWindow(nowSeconds = Math.floor(Date.now() / 1000)): number {
  return Math.floor(nowSeconds / ATTEMPT_WINDOW_SECONDS) * ATTEMPT_WINDOW_SECONDS;
}
