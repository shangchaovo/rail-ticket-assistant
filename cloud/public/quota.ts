import {PublicError,dailyWindow,IP_DAILY_LIMIT,PUBLIC_DAILY_LIMIT,CONCURRENT_LIMIT} from './policy.ts';
export const ASSISTANT_IP_LIMIT=15,ASSISTANT_DAILY_LIMIT=50;
async function consume(db:D1Database,visitor:string,now:number,assistant=false){
 const day=dailyWindow(now),prefix=assistant?'ai:':'',ipLimit=assistant?ASSISTANT_IP_LIMIT:IP_DAILY_LIMIT,globalLimit=assistant?ASSISTANT_DAILY_LIMIT:PUBLIC_DAILY_LIMIT;
 const ip=await db.prepare('INSERT INTO public_limits(scope,day,used,last_at) VALUES (?,?,1,?) ON CONFLICT(scope,day) DO UPDATE SET used=used+1,last_at=excluded.last_at WHERE used < ? AND last_at <= ? RETURNING used').bind(prefix+'ip:'+visitor,day,now,ipLimit,now-(assistant?3000:10000)).first<{used:number}>();
 if(!ip)throw new PublicError(429,assistant?'AI 对话过于频繁或今日次数已用完，请稍后重试。':'查询过于频繁或今日次数已用完，请稍后再试。',60);
 const global=await db.prepare('INSERT INTO public_limits(scope,day,used,last_at) VALUES (?,?,1,?) ON CONFLICT(scope,day) DO UPDATE SET used=used+1,last_at=excluded.last_at WHERE used < ? RETURNING used').bind(prefix+'global',day,now,globalLimit).first<{used:number}>();
 if(!global)throw new PublicError(429,assistant?'今天的 AI 试用次数已用完，仍可使用条件查询。':'今天的公开查询名额已用完，请明天再试或直接前往 12306。',3600);
 return {remaining:ipLimit-ip.used};
}
/** An assistant already holds a shared concurrency lease; live queries still consume the ordinary query budget. */
export const consumeQueryQuota=(db:D1Database,visitor:string,now=Date.now())=>consume(db,visitor,now);
export async function acquireQuota(db:D1Database,visitor:string,now=Date.now(),kind:'query'|'assistant'='query'){
 const day=dailyWindow(now),id=crypto.randomUUID();
 await db.batch([db.prepare('DELETE FROM public_leases WHERE expires_at <= ?').bind(now),db.prepare('DELETE FROM public_limits WHERE day < ?').bind(day)]);
 const lease=await db.prepare('INSERT INTO public_leases(id,visitor,expires_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM public_leases) < ? AND NOT EXISTS(SELECT 1 FROM public_leases WHERE visitor=?) RETURNING id').bind(id,visitor,now+(kind==='assistant'?100000:65000),CONCURRENT_LIMIT,visitor).first<{id:string}>();
 if(!lease)throw new PublicError(429,'当前有人正在查询，请稍后再试；同一网络请等待上一轮结束。',15);
 const release=()=>db.prepare('DELETE FROM public_leases WHERE id=?').bind(id).run();
 try{
  return {release,...await consume(db,visitor,now,kind==='assistant')};
 }catch(error){await release();throw error;}
}
