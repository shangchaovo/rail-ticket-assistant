import {SEAT_LABELS,type RailJob,type RailSearch,type RailWatch,type SearchResult} from './rail-types.ts';

type Row=Record<string,string|number|null>;
export const MIN_INTERVAL_SECONDS=60;
export const MAX_WATCHES=8;
export const ONLINE_MS=90_000;
export const WATCH_JOB_SQL=`INSERT INTO jobs (id,owner_id,version,status,input_json,message,mode,watch_id,created_at,updated_at)
 SELECT ?,owner_id,1,'queued',input_json,'定时查询已到点，等待 Mac 助手','search',id,?,? FROM watches
 WHERE id=? AND status='active' AND next_run_at<=? AND end_at>?
 AND EXISTS (SELECT 1 FROM devices WHERE owner_id=watches.owner_id AND revoked_at IS NULL AND last_seen>?)
 AND NOT EXISTS (SELECT 1 FROM jobs WHERE watch_id=watches.id AND status IN ('queued','running','waiting_user'))
 AND (SELECT COUNT(*) FROM jobs WHERE owner_id=watches.owner_id AND status IN ('queued','running','waiting_user'))<3
 ON CONFLICT DO NOTHING RETURNING id`;

export function watchFromRow(r:Row):RailWatch {
 return {id:String(r.id),name:String(r.name),input:JSON.parse(String(r.input_json)),startAt:String(r.start_at),intervalSeconds:Number(r.interval_seconds),endAt:String(r.end_at),status:r.status as RailWatch['status'],stopOnAvailable:!!r.stop_on_available,nextRunAt:String(r.next_run_at),lastRunAt:r.last_run_at?String(r.last_run_at):null,lastJobId:r.last_job_id?String(r.last_job_id):null,message:String(r.message)};
}
export function watchTimes(input:RailSearch,startAt:string,endAt:string,intervalSeconds:number,now=Date.now()) {
 const start=Date.parse(startAt),end=Date.parse(endAt);
 const departure=Date.parse(`${input.date}T${input.earliestTime}:00+08:00`);
 const latest=Date.parse(`${input.date}T23:59:59+08:00`);
 if(!Number.isInteger(intervalSeconds)||intervalSeconds<MIN_INTERVAL_SECONDS||intervalSeconds>3600)throw new Error('重查间隔须为 60–3600 秒');
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=Math.max(start,now)||end>latest)throw new Error('结束时间须晚于开始时间且不超过乘车当天');
 // With an explicit earliest departure, stop the watch before that threshold.
 if(departure>now&&start>=latest)throw new Error('盯票开始时间超过乘车日');
 return {startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),nextRunAt:new Date(Math.max(start,now)).toISOString()};
}
export function hasFreshTickets(result:SearchResult|undefined,job:Pick<RailJob,'createdAt'|'input'>,now=Date.now()) {
 const earliest=Date.parse(job.createdAt)-5_000;
 return !!result?.plans.some(p=>p.kind!=='extension'&&!p.uncovered&&p.legs.every(l=>{
  const fetched=Date.parse(l.fetchedAt),depart=Date.parse(l.departureIso),count=job.input.passengerCount??1;
  return l.inventory.status==='available'&&l.inventory.count!==0&&(count===1||Number(l.inventory.count)>=count)&&fetched>=earliest&&fetched<=now+5_000&&depart>now;
 }));
}
export function barkKey(value:string) {
 let url:URL;try{url=new URL(value);}catch{throw new Error('请粘贴 Bark 的 https://api.day.app/设备密钥 地址');}
 if(url.protocol!=='https:'||url.hostname!=='api.day.app'||url.port||url.username||url.password||url.search||url.hash||!/^\/[A-Za-z0-9_-]{8,200}\/?$/.test(url.pathname))throw new Error('目前仅支持 https://api.day.app/设备密钥；不支持其他推送地址');
 return url.pathname.split('/')[1];
}
export async function enqueueNotification(db:D1Database,ownerId:string,eventKey:string,kind:string,title:string,message:string,url:string,now=Date.now()) {
 const setting=await db.prepare('SELECT enabled,bark_key FROM notification_settings WHERE owner_id=?').bind(ownerId).first<Row>();
 const stamp=new Date(now).toISOString();
 const pending=!!setting?.enabled&&!!setting.bark_key;
 await db.prepare(`INSERT INTO notification_events (id,owner_id,event_key,kind,title,message,url,created_at,next_attempt_at,delivery_status,delivery_message) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`).bind(crypto.randomUUID(),ownerId,eventKey,kind,title,message,url,stamp,stamp,pending?'pending':'disabled',pending?'等待手机推送':'手机提醒未配置或已关闭').run();
}
export async function flushNotifications(db:D1Database,send:typeof fetch=fetch,now?:number) {
 const clock=()=>now??Date.now(),initialStamp=new Date(clock()).toISOString();
 await db.prepare("UPDATE notification_events SET delivery_status='failed',delivery_message='未取得推送确认，请检查手机提醒配置',claim_until=NULL WHERE delivery_status='pending' AND attempts>=3 AND (claim_until IS NULL OR claim_until<?)").bind(initialStamp).run();
 const rows=await db.prepare(`SELECT e.*,s.bark_key,s.enabled FROM notification_events e LEFT JOIN notification_settings s ON s.owner_id=e.owner_id WHERE e.delivery_status='pending' AND e.attempts<3 AND e.next_attempt_at<=? AND (e.claim_until IS NULL OR e.claim_until<?) ORDER BY e.created_at LIMIT 8`).bind(initialStamp,initialStamp).all<Row>();
 for(const r of rows.results){
  if(!r.enabled||!r.bark_key){await db.prepare("UPDATE notification_events SET delivery_status='disabled',delivery_message='未配置或已关闭手机提醒' WHERE id=?").bind(r.id).run();continue;}
  const at=clock(),stamp=new Date(at).toISOString(),claim=new Date(at+30_000).toISOString();
  const locked=await db.prepare(`UPDATE notification_events SET claim_until=?,attempts=attempts+1 WHERE id=? AND delivery_status='pending' AND attempts<3 AND next_attempt_at<=? AND (claim_until IS NULL OR claim_until<?) AND EXISTS (SELECT 1 FROM notification_settings s WHERE s.owner_id=notification_events.owner_id AND s.enabled=1 AND s.bark_key=?) RETURNING attempts`).bind(claim,r.id,stamp,stamp,r.bark_key).first<Row>();
  if(!locked)continue;
  try {
   const response=await send('https://api.day.app/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_key:r.bark_key,title:r.title,body:r.message,url:r.url,group:'同车余票'}),redirect:'error',signal:AbortSignal.timeout(10_000)});
   const answer=await response.json() as {code?:number};
   if(!response.ok||answer.code!==200)throw new Error('Push rejected');
   await db.prepare("UPDATE notification_events SET delivery_status='sent',delivery_message='推送服务已接受（是否显示由手机通知设置决定）',delivered_at=?,claim_until=NULL WHERE id=? AND claim_until=?").bind(new Date().toISOString(),r.id,claim).run();
  } catch {
   const attempts=Number(locked.attempts);
   await db.prepare('UPDATE notification_events SET delivery_status=?,delivery_message=?,next_attempt_at=?,claim_until=NULL WHERE id=? AND claim_until=?').bind(attempts>=3?'failed':'pending',attempts>=3?'手机推送失败，请检查 Bark 配置':'手机推送暂未成功，将重试',new Date(clock()+(attempts===1?60_000:300_000)).toISOString(),r.id,claim).run();
  }
 }
}
export async function pruneResultHistory(db:D1Database,ownerId:string,now=Date.now()) {
 // Keep recent inventories and each of the 30 visible watches' last result.
 // The rest keeps task metadata, never masquerading as a fresh empty result.
 await db.prepare(`UPDATE jobs SET result_json=NULL,status='unavailable',message='历史余票快照已清理，请重新查询实时余票',updated_at=? WHERE id IN (
  SELECT id FROM (SELECT id,ROW_NUMBER() OVER (ORDER BY created_at DESC,id DESC) AS position FROM jobs WHERE owner_id=? AND result_json IS NOT NULL AND status IN ('complete','partial','unavailable','cancelled')) WHERE position>50
 ) AND id NOT IN (SELECT last_job_id FROM (SELECT last_job_id FROM watches WHERE owner_id=? AND last_job_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 30))`).bind(new Date(now).toISOString(),ownerId,ownerId).run();
}
async function maintainHistory(db:D1Database,now:number) {
 const reserved=await db.prepare("INSERT INTO rail_maintenance (name,last_ms) VALUES ('history',?) ON CONFLICT(name) DO UPDATE SET last_ms=excluded.last_ms WHERE rail_maintenance.last_ms<? RETURNING name").bind(now,now-15*60_000).first<Row>();
 if(!reserved)return;
 const cutoff=new Date(now-30*86400_000).toISOString();
 await db.prepare(`DELETE FROM jobs WHERE status IN ('complete','partial','unavailable','cancelled') AND (created_at<? OR id IN (SELECT id FROM (SELECT id,ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY created_at DESC,id DESC) AS position FROM jobs WHERE status IN ('complete','partial','unavailable','cancelled')) WHERE position>200)) AND id NOT IN (SELECT last_job_id FROM (SELECT last_job_id,ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY created_at DESC,id DESC) AS position FROM watches WHERE last_job_id IS NOT NULL) WHERE position<=30)`).bind(cutoff).run();
 await db.prepare("UPDATE watches SET last_job_id=NULL,message='历史查询已过期；需要余票时请重新查询' WHERE last_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id=watches.last_job_id)").run();
 await db.prepare("DELETE FROM watches WHERE status='completed' AND updated_at<?").bind(new Date(now-90*86400_000).toISOString()).run();
 await db.prepare("DELETE FROM notification_events WHERE created_at<? AND delivery_status IN ('sent','failed','disabled')").bind(cutoff).run();
 await db.prepare("UPDATE notification_events SET delivery_status='failed',delivery_message='提醒已过期，请查看当前查询状态',claim_until=NULL WHERE created_at<? AND delivery_status='pending'").bind(new Date(now-86400_000).toISOString()).run();
 await db.prepare('DELETE FROM released_runners WHERE released_at<?').bind(new Date(now-7*86400_000).toISOString()).run();
}
export async function watchOutcome(db:D1Database,job:RailJob,status:string,message:string,result?:SearchResult,origin='') {
 if(status==='waiting_user')await enqueueNotification(db,String((await db.prepare('SELECT owner_id FROM jobs WHERE id=?').bind(job.id).first<Row>())?.owner_id),`verify:${job.id}`,'verification','12306 需要本人处理',message,`${origin}/?query=${encodeURIComponent(job.id)}`);
 if(!job.watchId)return;
 const w=await db.prepare('SELECT * FROM watches WHERE id=?').bind(job.watchId).first<Row>();
 if(!w)return;
 const now=Date.now(),stamp=new Date(now).toISOString(),fresh=hasFreshTickets(result,job,now);
 if(fresh){
  const changed=await db.prepare(`UPDATE watches SET was_available=1,status=CASE WHEN stop_on_available=1 THEN 'completed' ELSE status END,message='发现可买方案，请打开官网复核并购票',updated_at=? WHERE id=? AND was_available=0 AND status='active'`).bind(stamp,w.id).run();
  if(changed.meta.changes){
   const plan=result?.plans.find(p=>hasFreshTickets({...result!,plans:[p]},job,now));
   const summary=plan?`${plan.kind==='transfer'?plan.legs.map(l=>l.train?.trainCode).join(' → '):plan.train?.trainCode||''} ${plan.legs.map(l=>`${l.from?.name||''}→${l.to?.name||''} ${SEAT_LABELS[l.seat]||''}`).join('；')}`:'';
   await enqueueNotification(db,String(w.owner_id),`tickets:${w.id}:${job.id}`,'tickets','同车余票：发现可买方案',`${w.name}；${summary}。库存采集于本次查询，请及时复核并购票。`,`${w.site_origin}/?query=${encodeURIComponent(job.id)}`);
  }
 }
 if(['complete','partial','unavailable'].includes(status)){
  const cooldown=/限流|429|验证码|验证|登录/.test(message+' '+(result?.issues||[]).join(' '));
  const next=new Date(now+Math.max(Number(w.interval_seconds),cooldown?600:0)*1000).toISOString();
  await db.prepare(`UPDATE watches SET next_run_at=?,last_run_at=?,message=CASE WHEN status='completed' THEN message ELSE ? END,was_available=CASE WHEN ?=1 THEN 0 ELSE was_available END,updated_at=? WHERE id=?`).bind(next,stamp,cooldown?'官网要求暂停，至少 10 分钟后再查':fresh?'已发现可买方案':message,result?.complete&&!fresh?1:0,stamp,w.id).run();
 }
}
export async function tickWatches(db:D1Database,ownerId?:string,now=Date.now()) {
 const stamp=new Date(now).toISOString(),onlineAfter=new Date(now-ONLINE_MS).toISOString();
 await maintainHistory(db,now);
 // No browser polling is needed for expiration, lost leases, or waking up later.
 await db.prepare("UPDATE jobs SET status='cancelled',message='盯票时段已结束',lease_token=NULL,lease_until=NULL,updated_at=? WHERE watch_id IN (SELECT id FROM watches WHERE end_at<=?) AND status IN ('queued','running','waiting_user')").bind(stamp,stamp).run();
 await db.prepare("UPDATE watches SET status='completed',message='盯票时段已结束',updated_at=? WHERE status='active' AND end_at<=?").bind(stamp,stamp).run();
 const expired=await db.prepare(`SELECT j.*,w.site_origin,w.interval_seconds FROM jobs j LEFT JOIN watches w ON w.id=j.watch_id WHERE j.status IN ('running','waiting_user') AND j.lease_until<? LIMIT 20`).bind(stamp).all<Row>();
 for(const j of expired.results){
  const changed=await db.prepare("UPDATE jobs SET status='unavailable',message='电脑休眠、断网或助手中断，本轮未完成；已采集结果仅供参考',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND lease_until<?").bind(stamp,j.id,j.lease_token,stamp).run();
  if(changed.meta.changes&&j.watch_id)await db.prepare("UPDATE watches SET next_run_at=?,message='本轮中断，等待 Mac 恢复在线后重查',updated_at=? WHERE id=? AND status='active'").bind(new Date(now+Number(j.interval_seconds)*1000).toISOString(),stamp,j.watch_id).run();
 }
 const rows=await db.prepare(`SELECT w.*,d.last_seen FROM watches w LEFT JOIN devices d ON d.owner_id=w.owner_id AND d.revoked_at IS NULL WHERE w.status='active' AND w.next_run_at<=? ${ownerId?'AND w.owner_id=?':''} ORDER BY w.next_run_at LIMIT 20`).bind(stamp,...(ownerId?[ownerId]:[])).all<Row>();
 for(const w of rows.results){
  if(!w.last_seen||String(w.last_seen)<onlineAfter){
   await db.prepare("UPDATE watches SET message='Mac 离线或休眠，查询暂停；恢复在线后自动查一次',updated_at=? WHERE id=? AND status='active'").bind(stamp,w.id).run();
   if(w.last_seen)await enqueueNotification(db,String(w.owner_id),`offline:${w.owner_id}:${w.last_seen}`,'offline','同车余票：Mac 已离线','电脑休眠或断网时无法查询，恢复在线后会自动重查。',`${w.site_origin}/` ,now);
   continue;
  }
  const id=crypto.randomUUID();
  // Atomic INSERT plus the unique partial index prevent duplicate watch jobs.
  const queued=await db.prepare(WATCH_JOB_SQL).bind(id,stamp,stamp,w.id,stamp,stamp,onlineAfter).first<Row>();
  if(queued)await db.prepare("UPDATE watches SET last_job_id=?,last_run_at=?,next_run_at=?,message='已到点，等待电脑查询',updated_at=? WHERE id=? AND status='active'").bind(id,stamp,new Date(now+Number(w.interval_seconds)*1000).toISOString(),stamp,w.id).run();
 }
}
