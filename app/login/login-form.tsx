'use client';

import { useRef, useState } from 'react';
import { ArrowRight, Eye, EyeOff, LoaderCircle, TriangleAlert } from 'lucide-react';
import { safeReturnPath } from '@/lib/private-auth';
import styles from './login.module.css';

export default function LoginForm({ returnTo, configured }: { returnTo: string; configured: boolean }) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (!configured || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, returnTo }) });
      const value: unknown = await response.json().catch(() => null);
      const data = value && typeof value === 'object' ? value as { error?: string; redirect?: string } : null;
      if (!response.ok || !data?.redirect) throw new Error(data?.error || '登录暂时不可用，请稍后重试。');
      setPassword('');
      window.location.assign(safeReturnPath(data.redirect));
    } catch (error) {
      setError((error as Error).message); setPassword(''); setBusy(false); input.current?.focus();
    }
  }
  return <form className={styles.form} onSubmit={login}>
    <label htmlFor="private-password">私人密码</label>
    <div className={styles.password}><input id="private-password" name="password" ref={input} type={visible ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} required autoComplete="current-password" placeholder="请输入私人密码" maxLength={1024} disabled={!configured || busy} autoFocus /><button type="button" onClick={() => setVisible(current => !current)} aria-label={visible ? '隐藏密码' : '显示密码'} disabled={busy}>{visible ? <EyeOff size={19} /> : <Eye size={19} />}</button></div>
    {(!configured || error) && <p className={styles.error} role="alert"><TriangleAlert size={17} /><span>{configured ? error : '私人登录尚未配置完成，暂时无法进入。'}</span></p>}
    <button type="submit" className={styles.submit} disabled={!configured || busy || !password}>{busy ? <LoaderCircle size={18} className="spin" /> : null}{busy ? '正在登录…' : '进入我的工作台'}{!busy && <ArrowRight size={18} />}</button>
    <p className={styles.session}>登录状态保留 7 天。公共设备使用后请退出登录。</p>
  </form>;
}
