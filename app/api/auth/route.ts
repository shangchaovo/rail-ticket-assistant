import { env } from 'cloudflare:workers';
import { LOGIN_ATTEMPT_SQL, attemptWindow, createPrivateSession, privateConfig, safeReturnPath, sameOrigin, sessionCookie, sha256Hex, verifyPassword } from '@/lib/private-auth';
import type { PrivateAuthEnv } from '@/lib/private-auth';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200, extraHeaders: Record<string, string> = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...extraHeaders } });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: '请求来源无效，请从本站登录。' }, 403);
  const config = privateConfig(env as unknown as PrivateAuthEnv);
  if (!config) return json({ error: '私人登录尚未配置完成，请稍后重试。' }, 503);
  try {
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return json({ error: '请求格式无效。' }, 400);
    if (Number(request.headers.get('Content-Length') || 0) > 4096) return json({ error: '请求内容过长。' }, 413);
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: '请求内容过长。' }, 413);
    let body: { action?: unknown; password?: unknown; returnTo?: unknown };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: '请求格式无效。' }, 400);
      body = parsed;
    } catch { return json({ error: '请求格式无效。' }, 400); }
    const returnTo = safeReturnPath(body.returnTo);
    if (body.action === 'logout') return json({ redirect: `/login?return_to=${encodeURIComponent(returnTo)}` }, 200, { 'Set-Cookie': sessionCookie('', request.url, true) });
    if (body.action !== undefined && body.action !== 'login') return json({ error: '操作无效。' }, 400);
    if (typeof body.password !== 'string' || !body.password.length || body.password.length > 1024) return json({ error: '请输入有效密码。' }, 400);
    if (!env.DB) return json({ error: '登录服务暂不可用，请稍后重试。' }, 503);
    const ipHash = await sha256Hex(`${config.sessionSecret}:${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
    const windowStart = attemptWindow();
    await env.DB.prepare('DELETE FROM auth_attempts WHERE window_start < ?').bind(windowStart - 1200).run();
    // Single atomic increment permits at most six password verifications per IP/window.
    const attempt = await env.DB.prepare(LOGIN_ATTEMPT_SQL).bind(ipHash, windowStart).first<{ attempts: number }>();
    if (!attempt) return json({ error: '尝试次数过多，请在 10 分钟后重试。' }, 429, { 'Retry-After': String(windowStart + 600 - Math.floor(Date.now() / 1000)) });
    if (!await verifyPassword(body.password, config)) return json({ error: '密码不正确，请重试。' }, 401);
    const token = await createPrivateSession(config);
    await env.DB.prepare('DELETE FROM auth_attempts WHERE ip_hash = ?').bind(ipHash).run();
    return json({ redirect: returnTo }, 200, { 'Set-Cookie': sessionCookie(token, request.url) });
  } catch {
    // No request bodies, credentials, or session tokens are written to logs.
    return json({ error: '登录服务暂不可用，请稍后重试。' }, 503);
  }
}
