import { env } from 'cloudflare:workers';
import { redirect } from 'next/navigation';
import { LockKeyhole, ShieldCheck, TrainFront } from 'lucide-react';
import { getChatGPTUser } from '../chatgpt-auth';
import { authMode, privateConfig, safeReturnPath } from '@/lib/private-auth';
import type { PrivateAuthEnv } from '@/lib/private-auth';
import LoginForm from './login-form';
import styles from './login.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: '私人登录 · 同车余票' };

export default async function Login({ searchParams }: { searchParams: Promise<{ return_to?: string }> }) {
  const returnTo = safeReturnPath((await searchParams).return_to);
  const settings = env as unknown as PrivateAuthEnv;
  if (authMode(settings) === 'sites') redirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`);
  if (await getChatGPTUser()) redirect(returnTo);
  return <main className={styles.page}>
    <div className={styles.brand}><span><TrainFront size={26} /></span><div><strong>同车余票</strong><small>12306 同车路线助手</small></div></div>
    <section className={styles.card} aria-labelledby="login-title">
      <div className={styles.lock}><LockKeyhole size={24} /></div>
      <p className={styles.eyebrow}>私人出行工作台</p>
      <h1 id="login-title">欢迎回来</h1>
      <p className={styles.intro}>输入你的私人密码，继续查询余票与同车路线。</p>
      <LoginForm returnTo={returnTo} configured={Boolean(privateConfig(settings))} />
      <div className={styles.privacy}><ShieldCheck size={17} /><p>仅限你本人访问。12306 登录状态保留在自己的 Mac 上。</p></div>
    </section>
    <p className={styles.footer}>同车余票 · 你的私人铁路路线助手</p>
  </main>;
}
