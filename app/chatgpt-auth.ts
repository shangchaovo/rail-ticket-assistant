import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authMode, privateConfig, readPrivateSession, safeReturnPath } from '@/lib/private-auth';
import type { PrivateAuthEnv } from '@/lib/private-auth';

export type ChatGPTUser = { userId: string; displayName: string; email: string; fullName: string | null };
const USER_ID_HEADER = 'oai-authenticated-user-id';
const USER_EMAIL_HEADER = 'oai-authenticated-user-email';
const USER_FULL_NAME_HEADER = 'oai-authenticated-user-full-name';
const USER_FULL_NAME_ENCODING_HEADER = 'oai-authenticated-user-full-name-encoding';
const PERCENT_ENCODED_UTF8 = 'percent-encoded-utf-8';
const privateEnv = () => env as unknown as PrivateAuthEnv;

/** Private mode deliberately never trusts Sites identity headers. */
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const mode = authMode(privateEnv());
  if (mode === 'private') {
    const session = await readPrivateSession(requestHeaders.get('cookie'), privateConfig(privateEnv()));
    return session ? { userId: session.sub, displayName: '我的私人工作台', email: '', fullName: null } : null;
  }
  if (mode !== 'sites') return null;
  const userId = requestHeaders.get(USER_ID_HEADER);
  const email = requestHeaders.get(USER_EMAIL_HEADER);
  if (!userId || !email) return null;
  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName = encodedFullName && requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8 ? safeDecodeURIComponent(encodedFullName) : null;
  return { userId, displayName: fullName ?? email, email, fullName };
}

export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}
export function chatGPTSignInPath(returnTo: string): string {
  const safe = safeReturnPath(returnTo);
  if (authMode(privateEnv()) !== 'sites') return `/login?return_to=${encodeURIComponent(safe)}`;
  return `/signin-with-chatgpt?return_to=${encodeURIComponent(safe)}`;
}
/** Private logout is POST /api/auth with { action: 'logout' }; this path is only a navigation fallback. */
export function chatGPTSignOutPath(returnTo = '/'): string {
  const safe = safeReturnPath(returnTo);
  return authMode(privateEnv()) === 'sites' ? `/signout-with-chatgpt?return_to=${encodeURIComponent(safe)}` : `/login?return_to=${encodeURIComponent(safe)}`;
}
function safeDecodeURIComponent(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}
