import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { PrivateAuthConfig, PrivateAuthEnv } from '../lib/private-auth';

const auth: typeof import('../lib/private-auth') = await import(new URL('../lib/private-auth.ts', import.meta.url).href);
const owner = 'a2546405-d5a1-4da4-a786-182ea22abf16';
const env: PrivateAuthEnv = { RAIL_AUTH_MODE: 'private', RAIL_OWNER_ID: owner, RAIL_PASSWORD_HASH: await auth.sha256Hex('a-long-test-only-password'), RAIL_SESSION_SECRET: 'test-only-session-secret-with-over-thirty-two-characters' };
const config = auth.privateConfig(env)!;
const now = 1700000000;

async function signedPayload(payload: unknown, settings: PrivateAuthConfig = config) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(settings.sessionSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
  return `${encoded}.${Buffer.from(signature).toString('base64url')}`;
}

test('private mode fails closed on every missing or invalid credential', () => {
  assert.equal(auth.authMode({}), 'sites');
  assert.equal(auth.authMode({ RAIL_AUTH_MODE: 'private' }), 'private');
  assert.equal(auth.authMode({ RAIL_AUTH_MODE: 'unknown' }), 'invalid');
  for (const key of ['RAIL_OWNER_ID', 'RAIL_PASSWORD_HASH', 'RAIL_SESSION_SECRET'] as const) {
    const incomplete = { ...env }; delete incomplete[key];
    assert.equal(auth.privateConfig(incomplete), null);
  }
  assert.equal(auth.privateConfig({ ...env, RAIL_OWNER_ID: 'not-an-owner-id' }), null);
  assert.equal(auth.privateConfig({ ...env, RAIL_PASSWORD_HASH: 'a'.repeat(63) }), null);
  assert.equal(auth.privateConfig({ ...env, RAIL_SESSION_SECRET: 'short' }), null);
  assert.equal(auth.privateConfig({ ...env, RAIL_AUTH_MODE: 'sites' }), null);
  assert.equal(config.ownerId, owner);
});

test('correct password is accepted and invalid values are rejected', async () => {
  assert.equal(await auth.verifyPassword('a-long-test-only-password', config), true);
  assert.equal(await auth.verifyPassword('wrong-password', config), false);
  assert.equal(await auth.verifyPassword(undefined, config), false);
  assert.equal(await auth.verifyPassword('x'.repeat(1025), config), false);
  assert.equal(auth.constantTimeEqual('abc', 'abc'), true);
  assert.equal(auth.constantTimeEqual('abc', 'abc\0'), false);
});
test('new password hashes are salted PBKDF2 and reject wrong passwords or malformed parameters', async () => {
  const password = 'only-a-test-password';
  const first = await auth.createPasswordHash(password), second = await auth.createPasswordHash(password);
  assert.match(first, /^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  const settings = auth.privateConfig({ ...env, RAIL_PASSWORD_HASH: first })!;
  assert.equal(await auth.verifyPassword(password, settings), true);
  assert.equal(await auth.verifyPassword('wrong-test-password', settings), false);
  for (const invalid of [first.replace('$100000$', '$1$'), first.replace('$100000$', '$999999999$'), first.slice(0, -1), 'pbkdf2-sha256$100000$invalid$hash']) {
    assert.equal(auth.privateConfig({ ...env, RAIL_PASSWORD_HASH: invalid }), null);
    assert.equal(await auth.verifyPassword(password, { ...config, passwordHash: invalid }), false);
  }
  await assert.rejects(auth.createPasswordHash(''));
});

test('signed session belongs only to the configured owner and expires after seven days', async () => {
  const token = await auth.createPrivateSession(config, now);
  assert.equal((await auth.verifyPrivateSession(token, config, now))?.sub, owner);
  assert.equal((await auth.verifyPrivateSession(token, config, now + auth.SESSION_SECONDS - 1))?.sub, owner);
  assert.equal(await auth.verifyPrivateSession(token, config, now + auth.SESSION_SECONDS), null);
  assert.equal(await auth.verifyPrivateSession(token, config, now - 1), null);
  assert.equal(await auth.verifyPrivateSession(token, { ...config, ownerId: '67dca330-129c-43db-9fab-f644e02ff45d' }, now), null);
  assert.equal(await auth.verifyPrivateSession(token, { ...config, sessionSecret: 'another-different-long-session-secret-value' }, now), null);
});

test('tampered, malformed, padded, and oversized sessions cannot authenticate', async () => {
  const token = await auth.createPrivateSession(config, now);
  const [payload, signature] = token.split('.');
  const changed = Buffer.from(JSON.stringify({ v: 1, sub: owner, iat: now, exp: now + auth.SESSION_SECONDS + 1 })).toString('base64url');
  for (const invalid of [changed + '.' + signature, `${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`, `${payload}=.${signature}`, `${payload}.${signature}.extra`, 'wrong-value', '.', 'x'.repeat(2049)]) {
    assert.equal(await auth.verifyPrivateSession(invalid, config, now), null);
  }
  const excessiveLifetime = await signedPayload({ v: 1, sub: owner, iat: now, exp: now + auth.SESSION_SECONDS * 2 });
  assert.equal(await auth.verifyPrivateSession(excessiveLifetime, config, now), null);
  const wrongVersion = await signedPayload({ v: 2, sub: owner, iat: now, exp: now + auth.SESSION_SECONDS });
  assert.equal(await auth.verifyPrivateSession(wrongVersion, config, now), null);
});

test('cookie parsing rejects duplicate sessions and does not use any other identity value', async () => {
  const token = await auth.createPrivateSession(config, now);
  assert.equal((await auth.readPrivateSession(`unrelated=value; rail_session=${token}; other=1`, config, now))?.sub, owner);
  assert.equal(await auth.readPrivateSession(`rail_session=${token}; rail_session=${token}`, config, now), null);
  assert.equal(await auth.readPrivateSession(`oai-authenticated-user-id=${owner}`, config, now), null);
  assert.equal(await auth.readPrivateSession(`rail_session=${token}`, null, now), null);
  assert.equal(await auth.readPrivateSession(null, config, now), null);
});

test('same-origin validation requires an exact Origin for login and logout CSRF protection', () => {
  const url = 'https://rail-test.example/api/auth';
  assert.equal(auth.sameOrigin(new Request(url, { method: 'POST', headers: { Origin: 'https://rail-test.example' } })), true);
  for (const origin of ['https://attacker.example', 'http://rail-test.example', 'https://rail-test.example.attacker.example', 'https://rail-test.example:444', 'null', 'https://rail-test.example/']) {
    assert.equal(auth.sameOrigin(new Request(url, { method: 'POST', headers: { Origin: origin } })), false);
  }
  assert.equal(auth.sameOrigin(new Request(url, { method: 'POST' })), false);
});

test('return paths permit only safe local navigation and avoid login loops', () => {
  assert.equal(auth.safeReturnPath('/?route=rail#result'), '/?route=rail#result');
  assert.equal(auth.safeReturnPath('/downloads/rail-helper.zip'), '/downloads/rail-helper.zip');
  for (const value of [undefined, 5, '', 'https://attacker.example', '//attacker.example', '/\\attacker.example', '/%5cattacker.example', '/%2f%2fattacker.example', '/%252f%252fattacker.example', '/\n/attacker.example', '/login', '/login/', '/lo%67in', '/api/auth', '/api/auth/logout', '/callback', '/signin-with-chatgpt', '/signout-with-chatgpt']) {
    assert.equal(auth.safeReturnPath(value), '/');
  }
});

test('session cookies are HttpOnly, Strict, host-only, and Secure on HTTPS; logout clears the same cookie', () => {
  const secure = auth.sessionCookie('signed-token', 'https://rail-test.example/api/auth');
  for (const attribute of ['rail_session=signed-token', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=604800', 'Secure']) assert.ok(secure.includes(attribute));
  assert.ok(!secure.includes('Domain='));
  assert.ok(!auth.sessionCookie('signed-token', 'http://127.0.0.1:5173/api/auth').includes('Secure'));
  const cleared = auth.sessionCookie('', 'https://rail-test.example/api/auth', true);
  for (const attribute of ['rail_session=', 'Max-Age=0', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Expires=Thu, 01 Jan 1970']) assert.ok(cleared.includes(attribute));
});

test('D1-compatible atomic attempt counter permits only six attempts per fixed window and clears on success', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../drizzle/0001_private_auth.sql', import.meta.url), 'utf8'));
    const reserve = db.prepare(auth.LOGIN_ATTEMPT_SQL);
    const window = auth.attemptWindow(now);
    assert.equal(window % auth.ATTEMPT_WINDOW_SECONDS, 0);
    assert.equal(auth.attemptWindow(window + 599), window);
    assert.equal(auth.attemptWindow(window + 600), window + 600);
    for (let i = 1; i <= auth.MAX_ATTEMPTS; i++) assert.equal(reserve.get('hashed-ip', window)?.attempts, i);
    assert.equal(reserve.get('hashed-ip', window), undefined);
    assert.equal(reserve.get('another-ip', window)?.attempts, 1);
    assert.equal(reserve.get('hashed-ip', window + 600)?.attempts, 1);
    db.prepare('DELETE FROM auth_attempts WHERE ip_hash = ?').run('hashed-ip');
    assert.equal(reserve.get('hashed-ip', window)?.attempts, 1);
  } finally { db.close(); }
});
