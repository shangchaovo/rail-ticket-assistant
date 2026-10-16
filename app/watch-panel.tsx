'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, Check, Clock3, ExternalLink, LoaderCircle, Pause, Play, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import type { HelperState, RailSearch, RailWatch } from '@/lib/rail-types';

type NotificationSettings = { enabled: boolean; configured: boolean; barkUrl: null; lastDelivery: { status: string; message: string; at: string } | null };
const stamp = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function localTime(value: Date) {
  return new Date(value.getTime() + 8 * 3600_000).toISOString().slice(0, 16);
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

export default function WatchPanel({ input, helper, onOpenJob }: { input: RailSearch | null; helper: HelperState; onOpenJob: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [watches, setWatches] = useState<RailWatch[]>([]);
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(120);
  const [stopOnAvailable, setStopOnAvailable] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [barkUrl, setBarkUrl] = useState('');
  const inputDate = input?.date;

  const refresh = useCallback(async () => {
    const data = await request<{ watches: RailWatch[] }>('/api/watches');
    setWatches(data.watches);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setStartAt(localTime(new Date(Date.now() + 60000)));
      void Promise.all([refresh(), request<NotificationSettings>('/api/notifications').then(data => { setSettings(data); setEnabled(data.enabled); })]).catch(error => setError((error as Error).message));
    }, 0);
    const poll = setInterval(() => { void Promise.all([refresh(), request<NotificationSettings>('/api/notifications').then(setSettings)]).catch(error => setError((error as Error).message)); }, 15000);
    return () => { clearTimeout(timer); clearInterval(poll); };
  }, [refresh]);
  useEffect(() => {
    const timer = setTimeout(() => setEndAt(inputDate ? `${inputDate}T23:59` : ''), 0);
    return () => clearTimeout(timer);
  }, [inputDate]);

  async function addWatch(event: React.FormEvent) {
    event.preventDefault(); setError(''); setSaved('');
    if (!input || !input.date || !input.earliestTime || !input.seats.length || !input.trainTypes.length) { setError('请先选择完整的车票查询条件，再保存盯票。'); return; }
    if (!startAt || !endAt || Date.parse(`${endAt}:00+08:00`) <= Date.parse(`${startAt}:00+08:00`)) { setError('结束时间必须晚于首次查询时间。'); return; }
    setBusy('create');
    try {
      await request('/api/watches', { method: 'POST', body: JSON.stringify({ input, startAt: `${startAt}:00+08:00`, endAt: `${endAt}:00+08:00`, intervalSeconds, stopOnAvailable }) });
      await refresh(); setSaved('已保存盯票。关闭页面后，在线的 Mac 仍会按时查询。');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(''); }
  }
  async function changeWatch(watch: RailWatch, remove = false) {
    setBusy(watch.id); setError(''); setSaved('');
    try {
      await request(`/api/watches/${watch.id}`, { method: remove ? 'DELETE' : 'PATCH', ...(!remove ? { body: JSON.stringify({ status: watch.status === 'active' ? 'paused' : 'active' }) } : {}) });
      await refresh();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(''); }
  }
  async function saveNotifications(event?: React.FormEvent, remove = false) {
    event?.preventDefault(); setBusy('notifications'); setError(''); setSaved('');
    try {
      const data = await request<NotificationSettings>('/api/notifications', { method: 'PUT', body: JSON.stringify({ enabled: remove ? false : enabled, barkUrl: remove ? '' : barkUrl.trim() || null }) });
      setSettings(data); setEnabled(data.enabled); setBarkUrl('');
      setSaved(remove ? '已移除手机推送配置。' : '手机推送设置已保存；有新可买方案、需要本人验证或助手离线时会提醒。');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(''); }
  }
  const activeCount = watches.filter(watch => watch.status === 'active').length;

  return <section className="watch-panel" id="watch-panel" aria-label="定时盯票与提醒">
    <div className="watch-heading"><div><Bell size={18} /><h2>定时盯票与手机提醒</h2>{activeCount > 0 && <span className="total-count">{activeCount} 项运行中</span>}</div><button type="button" className="text-button" aria-expanded={open} aria-controls="watch-settings" onClick={() => setOpen(value => !value)}>{open ? '收起设置' : '设置盯票'}</button></div>
    <p className="watch-intro">保存当前行程，在起售前后或按间隔重新查。有可买方案就提醒你，再由你去官网购买。</p>
    {!helper.online && <p className="watch-offline"><TriangleAlert size={15} />Mac 当前离线。定时查询需要 Mac 开机、联网且保持唤醒；休眠期间无法采集，恢复后继续。</p>}
    {open && <div id="watch-settings" className="watch-settings-grid">
      <form className="watch-form" onSubmit={addWatch}>
        <h3><Clock3 size={16} />按当前查询条件盯票</h3>
        <p>{input ? `${input.origin.name} → ${input.destinations.map(station => station.name).join(' / ')} · ${input.date} · ${input.passengerCount ?? 1} 名成人` : '先在上方选择出发站、到站和日期。'}</p>
        <div className="watch-time-fields"><label>首次查询（北京时间）<input type="datetime-local" required value={startAt} onChange={event => setStartAt(event.target.value)} /></label><label>结束时间（北京时间）<input type="datetime-local" required value={endAt} onChange={event => setEndAt(event.target.value)} /></label></div>
        <label className="watch-interval">查询间隔<select value={intervalSeconds} onChange={event => setIntervalSeconds(Number(event.target.value))}>{[60, 120, 300, 600].map(seconds => <option value={seconds} key={seconds}>{seconds / 60} 分钟</option>)}</select></label>
        <label className="watch-checkbox"><input type="checkbox" checked={stopOnAvailable} onChange={event => setStopOnAvailable(event.target.checked)} />发现覆盖全程的可买方案后停止盯票</label>
        <p className="field-help">按保存时的条件查询；短票补票不算覆盖全程。官网限流或要求验证时会暂停。</p>
        <button className="secondary-button" type="submit" disabled={Boolean(busy) || !input}>{busy === 'create' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}保存当前行程盯票</button>
      </form>
      <form className="notification-form" onSubmit={saveNotifications}>
        <h3><Bell size={16} />网页之外的手机提醒</h3>
        <p>使用 Bark 推送到你的 iPhone。先在手机安装 Bark，复制你的推送地址。</p>
        <label htmlFor="bark-url">Bark 推送地址{settings?.configured && <span className="configured-label"><Check size={12} />已保存</span>}</label>
        <input id="bark-url" type="url" autoComplete="off" spellCheck={false} value={barkUrl} placeholder={settings?.configured ? '已有地址；留空保留，填入可替换' : 'https://api.day.app/你的推送密钥'} onChange={event => setBarkUrl(event.target.value)} />
        <p className="field-help">支持 api.day.app 官方地址。推送包含行程、车次和查询结果链接。</p>
        <label className="watch-checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />开启手机推送</label>
        <div className="notification-actions"><button className="secondary-button" disabled={Boolean(busy)} type="submit">{busy === 'notifications' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存提醒设置</button>{settings?.configured && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void saveNotifications(undefined, true)}>移除地址</button>}</div>
        {settings?.lastDelivery && <p className={`delivery-status ${settings.lastDelivery.status}`}>最近推送{settings.lastDelivery.status === 'failed' ? '失败' : settings.lastDelivery.status === 'sent' ? '已发送' : settings.lastDelivery.status === 'disabled' ? '已关闭' : ''}：{settings.lastDelivery.message} · {stamp(settings.lastDelivery.at)}</p>}
      </form>
    </div>}
    {error && <div className="inline-error" role="alert"><TriangleAlert size={15} />{error}</div>}
    {saved && <p className="watch-saved" role="status"><Check size={15} />{saved}</p>}
    {watches.length > 0 && <div className="watch-list">{watches.map(watch => <article className="watch-row" key={watch.id}>
      <div className="watch-route"><strong>{watch.input.origin.name}<span> → </span>{watch.input.destinations.map(station => station.name).join(' / ')}</strong><small>{watch.input.date} · {watch.input.earliestTime} 后 · {watch.input.passengerCount ?? 1} 名成人 · 每 {watch.intervalSeconds / 60} 分钟</small><p>{watch.message}</p><small>{watch.status === 'active' ? `下次查询 ${stamp(watch.nextRunAt)}` : watch.status === 'paused' ? '已暂停盯票' : '盯票已结束'}{watch.lastRunAt ? ` · 最近查询 ${stamp(watch.lastRunAt)}` : ''}</small></div>
      <div className="watch-row-actions"><span className={`watch-status ${watch.status}`}>{watch.status === 'active' ? '盯票中' : watch.status === 'paused' ? '已暂停' : '已结束'}</span>{watch.lastJobId && <button type="button" className="card-button" onClick={() => onOpenJob(watch.lastJobId!)}>查看结果<ExternalLink size={13} /></button>}{watch.status !== 'completed' && <button type="button" className="card-button" disabled={Boolean(busy)} onClick={() => void changeWatch(watch)}>{watch.status === 'active' ? <Pause size={13} /> : <Play size={13} />}{watch.status === 'active' ? '暂停' : '继续'}</button>}<button type="button" className="card-button" disabled={Boolean(busy)} onClick={() => void changeWatch(watch, true)}><Trash2 size={13} />删除</button></div>
    </article>)}</div>}
    {!watches.length && !open && <p className="watch-empty">还没有保存的盯票行程。<button type="button" className="text-button" onClick={() => setOpen(true)}><RefreshCw size={13} />设置首次查询时间</button></p>}
  </section>;
}
