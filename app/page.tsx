import { requireChatGPTUser } from './chatgpt-auth';
import RailApp from './rail-app';
import { env } from 'cloudflare:workers';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const query = (await searchParams)?.query;
  const returnTo = typeof query === 'string' && /^[0-9a-f-]{36}$/i.test(query) ? `/?query=${encodeURIComponent(query)}` : '/';
  await requireChatGPTUser(returnTo);
  return <RailApp privateLogin={env.RAIL_AUTH_MODE==='private'} />;
}
