import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { sameOrigin } from './private-auth';
import {privateAssistant} from './private-assistant';
import {PublicError} from '../cloud/public/policy';
import { helperUpdateSchema, inputSchema } from './rail-validation';
import {packResult, unpackResult} from './rail-wire';
import type { RailJob, RailSearch, TicketPlan } from './rail-types';
import stations from './stations.json';
import { searchStations } from './station-search';
import { jobEntityTag, matchesEntityTag } from './rail-http-cache';
import {watchFromRow,watchTimes,tickWatches,watchOutcome,barkKey,MAX_WATCHES,pruneResultHistory} from './rail-watch';
import {RUNNER_CLAIM_SQL,RUNNER_RENEW_SQL,RUNNER_LEASE_MS,RUNNER_RELEASE_JOBS_SQL} from './rail-device';
import { locateStation, mapSnapshot, MapServiceError, railwaySegment } from './rail-map-service';
type Row=Record<string,string|number|null>;
class ApiError extends Error { constructor(public code:number,message:string){super(message);} }
const stamp=()=>new Date().toISOString();
function database(){if(!env.DB)throw new ApiError(503,'查询服务暂时无法连接，请稍后重试');return env.DB;}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
async function body(req:Request){if(Number(req.headers.get('content-length')||0)>2_000_000)throw new ApiError(413,'查询结果过大，请减少备选到站或席别');const raw=await req.text();if(new TextEncoder().encode(raw).byteLength>2_000_000)throw new ApiError(413,'查询结果过大，请减少备选到站或席别');try{return JSON.parse(raw)}catch{throw new ApiError(400,'请求格式无效')}}
async function owner(){const u=await getChatGPTUser();if(!u)throw new ApiError(401,'请先登录');return u.userId;}
async function hash(token:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
async function device(req:Request){const token=req.headers.get('authorization')?.replace(/^Bearer /,'');if(!token||token.length<30)throw new ApiError(401,'查询助手尚未配对');const d=await database().prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL').bind(await hash(token)).first<Row>();if(!d)throw new ApiError(401,'查询助手配对凭据无效');return d;}
function job(row:Row):RailJob{return {id:String(row.id),version:Number(row.version),status:row.status as RailJob['status'],input:JSON.parse(String(row.input_json)),result:row.result_json?unpackResult(JSON.parse(String(row.result_json))):null,message:String(row.message),createdAt:String(row.created_at),updatedAt:String(row.updated_at),mode:row.mode as RailJob['mode'],...(row.watch_id?{watchId:String(row.watch_id)}:{}),...(row.recheck_json?{recheckPlan:JSON.parse(String(row.recheck_json))}:{})};}
async function ownJob(id:string,userId:string){const row=await database().prepare('SELECT * FROM jobs WHERE id=? AND owner_id=?').bind(id,userId).first<Row>();if(!row)throw new ApiError(404,'查询不存在');return row;}
async function helperState(userId:string){
 const d=await database().prepare('SELECT * FROM devices WHERE owner_id=? AND revoked_at IS NULL LIMIT 1').bind(userId).first<Row>();
 const online=!!d?.last_seen&&Date.now()-Date.parse(String(d.last_seen))<90000&&!!d.runner_until&&Date.parse(String(d.runner_until))>Date.now();
 const waiting=await database().prepare("SELECT id FROM jobs WHERE owner_id=? AND status='waiting_user' ORDER BY updated_at DESC LIMIT 1").bind(userId).first<Row>();
 return {online,lastSeen:d?.last_seen||null,deviceName:d?.name||null,waitingJobId:waiting?.id||null,message:online?(d?.message||'电脑查询助手在线'):'Mac 离线、休眠或助手未运行，当前无法查询；恢复在线后定时任务自动继续'};
}
async function runner(req:Request,d:Row,acquire=false){
 const id=req.headers.get('X-Rail-Runner-Id');
 if(!id||! /^[0-9a-f-]{36}$/i.test(id))throw new ApiError(426,'请更新至新版 Mac 助手；旧版本缺少单助手保护');
 const now=stamp(),until=new Date(Date.now()+RUNNER_LEASE_MS).toISOString();
 const updated=acquire?await database().prepare(RUNNER_CLAIM_SQL).bind(id,until,now,d.id,id,now,id).first<Row>():await database().prepare(RUNNER_RENEW_SQL).bind(until,now,d.id,id,now).first<Row>();
 if(!updated)throw new ApiError(409,'已有另一台助手在线，请停止它后再启动；令牌可在连接电脑中撤销');
 return updated;
}
async function createJob(userId:string,input:RailSearch,mode:'search'|'recheck'='search',plan?:TicketPlan){const active=await database().prepare("SELECT COUNT(*) AS n FROM jobs WHERE owner_id=? AND status IN ('queued','running','waiting_user')").bind(userId).first<{n:number}>();if((active?.n||0)>=3)throw new ApiError(429,'已有查询进行中，请等待或取消后再试');const state=await helperState(userId),now=stamp(),id=crypto.randomUUID();const status=state.online?'queued':'unavailable';const message=state.online?'已加入查询队列':'电脑查询助手离线，请启动后重新查询';await database().prepare('INSERT INTO jobs (id,owner_id,version,status,input_json,message,mode,recheck_json,created_at,updated_at) VALUES (?,?,1,?,?,?,?,?,?,?)').bind(id,userId,status,JSON.stringify(input),message,mode,plan?JSON.stringify(plan):null,now,now).run();return job(await ownJob(id,userId));}
function verifyStations(input:RailSearch){for(const s of [input.origin,...input.destinations,...(input.transferStations||[])])if(!stations.some(v=>v.code===s.code&&v.name===s.name))throw new ApiError(400,'请从建议列表选择有效车站');}
async function prune(){const cutoff=new Date(Date.now()-30*24*3600_000).toISOString();await database().prepare("DELETE FROM jobs WHERE updated_at<? AND status IN ('complete','partial','unavailable','cancelled')").bind(cutoff).run();}
export async function dispatch(req:Request,path:string[]){try{
 const p=path.join('/');
 if(p==='assistant'&&req.method==='POST'){
  const u=await owner();
  try{return await privateAssistant(req,{owner:u,db:database(),ai:env.AI,enabled:env.AI_ASSISTANT_ENABLED==='true',loadJob:async(id,userId)=>job(await ownJob(id,userId))});}
  catch(e){if(e instanceof PublicError)throw new ApiError(e.status,e.message);throw e;}
 }
 if(env.RAIL_AUTH_MODE==='private'&&!['GET','HEAD'].includes(req.method)&&(!p.startsWith('helper/')||p==='helper/resume')&&!sameOrigin(req))throw new ApiError(403,'请从当前私人网页提交请求');
 if(req.method==='GET'&&p==='helper/health'){if(env.RAIL_AUTH_MODE==='private')await device(req);await database().prepare('SELECT COUNT(*) AS n FROM jobs').first();return json({ready:true,queue:'ready'});}
 if(req.method==='GET'&&p==='stations'){await owner();return json(searchStations(new URL(req.url).searchParams.get('q')||''));}
 if(req.method==='GET'&&p==='helper/state')return json({helper:await helperState(await owner())});
 if(req.method==='DELETE'&&p==='device'){
  const u=await owner(),now=stamp();await database().batch([
   database().prepare('UPDATE devices SET revoked_at=?,runner_until=NULL WHERE owner_id=? AND revoked_at IS NULL').bind(now,u),
   database().prepare("UPDATE jobs SET status='unavailable',message='设备令牌已撤销，请重新连接 Mac',lease_token=NULL,lease_until=NULL,updated_at=? WHERE owner_id=? AND status IN ('running','waiting_user')").bind(now,u)
  ]);return json({ok:true});
 }
 if(req.method==='POST'&&p==='device'){
  const userId=await owner(),b=await body(req),now=stamp();const name=typeof b.deviceName==='string'?b.deviceName.slice(0,60):'我的 Mac';const deviceToken=crypto.randomUUID()+crypto.randomUUID(),id=crypto.randomUUID();
  await database().batch([
   database().prepare('UPDATE devices SET revoked_at=?,runner_until=NULL WHERE owner_id=? AND revoked_at IS NULL').bind(now,userId),
   database().prepare("UPDATE jobs SET status='unavailable',message='设备已重新配对，请用新助手重查',lease_token=NULL,lease_until=NULL,updated_at=? WHERE owner_id=? AND status IN ('running','waiting_user')").bind(now,userId),
   database().prepare('INSERT INTO devices (id,owner_id,token_hash,name,message,created_at) VALUES (?,?,?,?,?,?)').bind(id,userId,await hash(deviceToken),name,'等待电脑查询助手连接',now)
  ]);return json({deviceId:id,deviceToken,siteOrigin:new URL(req.url).origin},201);
 }
 if(req.method==='POST'&&p==='helper/resume'){
  const u=await owner(),b=await body(req);const waiting=await database().prepare(`SELECT id,device_id FROM jobs WHERE owner_id=? AND status='waiting_user' ${typeof b.jobId==='string'?'AND id=?':''} ORDER BY updated_at DESC LIMIT 1`).bind(u,...(typeof b.jobId==='string'?[b.jobId]:[])).first<Row>();
  if(!waiting)throw new ApiError(409,'没有等待本人处理的查询');
  const changed=await database().prepare('UPDATE devices SET resume_version=resume_version+1 WHERE id=? AND owner_id=? AND revoked_at IS NULL AND runner_until>?').bind(waiting.device_id,u,stamp()).run();
  if(!changed.meta.changes)throw new ApiError(409,'Mac 助手已离线，请先在 Mac 恢复助手');return json({ok:true,message:'恢复指令已发送；本轮保留结果，后续查询重新取得官方库存'});
 }
 if(req.method==='POST'&&p==='helper/release'){
  const d=await device(req),id=req.headers.get('X-Rail-Runner-Id');if(!id||id!==d.runner_id)throw new ApiError(409,'助手会话已变更');
  await database().batch([
   database().prepare(RUNNER_RELEASE_JOBS_SQL).bind(stamp(),d.id,id),
   database().prepare('INSERT INTO released_runners (device_id,runner_id,released_at) SELECT id,runner_id,? FROM devices WHERE id=? AND runner_id=? AND revoked_at IS NULL ON CONFLICT(device_id,runner_id) DO UPDATE SET released_at=excluded.released_at').bind(stamp(),d.id,id),
   database().prepare("UPDATE devices SET runner_id=NULL,runner_until=NULL,last_seen=NULL,message='电脑查询助手已停止' WHERE id=? AND runner_id=? AND revoked_at IS NULL").bind(d.id,id)
  ]);return json({ok:true});
 }
 if(p==='notifications'){
  const u=await owner();
  if(req.method==='PUT'){
   const b=await body(req);if(typeof b.enabled!=='boolean')throw new ApiError(400,'请选择是否启用手机提醒');
   const previous=await database().prepare('SELECT bark_key FROM notification_settings WHERE owner_id=?').bind(u).first<Row>();let key=previous?.bark_key||null;
   if(typeof b.barkUrl==='string'){try{key=b.barkUrl.trim()?barkKey(b.barkUrl.trim()):null;}catch(e){throw new ApiError(400,(e as Error).message);}}
   if(b.enabled&&!key)throw new ApiError(400,'请先填写 Bark 推送地址');
   await database().prepare('INSERT INTO notification_settings (owner_id,enabled,bark_key,updated_at) VALUES (?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,bark_key=excluded.bark_key,updated_at=excluded.updated_at').bind(u,b.enabled?1:0,key,stamp()).run();
  }else if(req.method!=='GET')throw new ApiError(405,'不支持的操作');
  const setting=await database().prepare('SELECT enabled,bark_key FROM notification_settings WHERE owner_id=?').bind(u).first<Row>();
  const last=await database().prepare('SELECT delivery_status,delivery_message,created_at FROM notification_events WHERE owner_id=? ORDER BY created_at DESC LIMIT 1').bind(u).first<Row>();
  return json({enabled:!!setting?.enabled,configured:!!setting?.bark_key,barkUrl:null,lastDelivery:last?{status:last.delivery_status,message:last.delivery_message,at:last.created_at}:null});
 }
 if(p==='watches'){
  const u=await owner();
  if(req.method==='GET'){await tickWatches(database(),u);const rows=await database().prepare('SELECT * FROM watches WHERE owner_id=? ORDER BY created_at DESC LIMIT 30').bind(u).all<Row>();return json({watches:rows.results.map(watchFromRow)});}
  if(req.method==='POST'){
   const b=await body(req),parsed=inputSchema.safeParse(b.input);if(!parsed.success)throw new ApiError(400,parsed.error.issues[0]?.message||'查询条件无效');verifyStations(parsed.data);
   const count=await database().prepare("SELECT COUNT(*) AS n FROM watches WHERE owner_id=? AND status IN ('active','paused')").bind(u).first<{n:number}>();if((count?.n||0)>=MAX_WATCHES)throw new ApiError(429,'最多保留 8 个盯票行程，请删除已不用的行程');
   let times;try{times=watchTimes(parsed.data,b.startAt,b.endAt,b.intervalSeconds);}catch(e){throw new ApiError(400,(e as Error).message);}
   const id=crypto.randomUUID(),now=stamp(),name=typeof b.name==='string'&&b.name.trim()?b.name.trim().slice(0,80):`${parsed.data.origin.name} → ${parsed.data.destinations.map(s=>s.name).join(' / ')} ${parsed.data.date}`;
   await database().prepare("INSERT INTO watches (id,owner_id,name,input_json,start_at,interval_seconds,end_at,status,stop_on_available,next_run_at,message,site_origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?,?)").bind(id,u,name,JSON.stringify(parsed.data),times.startAt,b.intervalSeconds,times.endAt,b.stopOnAvailable===false?0:1,times.nextRunAt,'到点后由 Mac 自动查询',new URL(req.url).origin,now,now).run();
   return json({watch:watchFromRow((await database().prepare('SELECT * FROM watches WHERE id=?').bind(id).first<Row>())!)},201);
  }
 }
 if(path[0]==='watches'&&path.length===2){
  const u=await owner(),w=await database().prepare('SELECT * FROM watches WHERE id=? AND owner_id=?').bind(path[1],u).first<Row>();if(!w)throw new ApiError(404,'盯票行程不存在');
  if(req.method==='DELETE'){await database().batch([database().prepare("UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,message='盯票已删除',updated_at=? WHERE watch_id=? AND owner_id=? AND status IN ('queued','running','waiting_user')").bind(stamp(),w.id,u),database().prepare('DELETE FROM watches WHERE id=? AND owner_id=?').bind(w.id,u)]);return json({ok:true});}
  if(req.method==='PATCH'){
   const b=await body(req);if(!['active','paused'].includes(b.status))throw new ApiError(400,'请选择启动或暂停盯票');if(b.status==='active'&&Date.parse(String(w.end_at))<=Date.now())throw new ApiError(400,'盯票时段已结束，请新建行程');
   await database().prepare('UPDATE watches SET status=?,next_run_at=?,was_available=0,message=?,updated_at=? WHERE id=? AND owner_id=?').bind(b.status,new Date(Math.max(Date.now(),Date.parse(String(w.start_at)))).toISOString(),b.status==='paused'?'盯票已暂停':'等待下一轮查询',stamp(),w.id,u).run();
   if(b.status==='paused')await database().prepare("UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,message='盯票已暂停',updated_at=? WHERE watch_id=? AND owner_id=? AND status IN ('queued','running','waiting_user')").bind(stamp(),w.id,u).run();
   return json({watch:watchFromRow((await database().prepare('SELECT * FROM watches WHERE id=?').bind(w.id).first<Row>())!)});
  }
 }
 if(req.method==='POST'&&p==='jobs'){const u=await owner();const parsed=inputSchema.safeParse((await body(req)).input);if(!parsed.success)throw new ApiError(400,parsed.error.issues[0]?.message||'查询条件无效');verifyStations(parsed.data);await prune();const active=await database().prepare("SELECT COUNT(*) AS n FROM jobs WHERE owner_id=? AND status IN ('queued','running','waiting_user')").bind(u).first<{n:number}>();if((active?.n||0)>=3)throw new ApiError(429,'已有查询进行中，请等待或取消后再试');return json({job:await createJob(u,parsed.data)},201);}
 if(path[0]==='jobs'&&path[1]){const u=await owner(),row=await ownJob(path[1],u);
  if(req.method==='POST'&&path[2]==='map'&&path.length<=4){
   const b=await body(req),plan=job(row).result?.plans.find(p=>p.id===b.planId);
   if(!plan)throw new ApiError(404,'方案不存在，请重新查询');
   if(path[3]==='cache'){
    const {startOffset:start,endOffset:end}=b;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>=plan.route.length)throw new ApiError(400,'经停站范围无效');
    return json(await mapSnapshot(database(),plan.route.map(stop=>stop.station),start,end));
   }
   if(path[3]==='segment'){
    const i=b.fromOffset;
    if(!Number.isInteger(i)||i<0||i>=plan.route.length-1)throw new ApiError(400,'经停区间无效');
    return json(await railwaySegment(database(),u,plan.route[i].station,plan.route[i+1].station,b));
   }
   if(path[3])throw new ApiError(404,'地图接口不存在');
   if(!Array.isArray(b.offsets)||b.offsets.length!==1||b.offsets.some((i:unknown)=>!Number.isInteger(i)||Number(i)<0||Number(i)>=plan.route.length))throw new ApiError(400,'经停站范围无效');
   return json(await locateStation(database(),u,plan.route[b.offsets[0]].station,b));
  }
  if(req.method==='GET'&&path.length===2){const current=job(row);const interrupted=['queued','running','waiting_user'].includes(current.status)&&(!(await helperState(u)).online||(current.status!=='queued'&&!!row.lease_until&&Date.parse(String(row.lease_until))<Date.now()));if(interrupted){await database().prepare("UPDATE jobs SET status='unavailable',message=?,updated_at=?,lease_token=NULL WHERE id=? AND status=? AND version=? AND lease_token IS ? AND lease_until IS ? AND updated_at=?").bind('电脑查询助手已断开，已取得的结果仅供参考，请启动后重新查询',stamp(),row.id,row.status,row.version,row.lease_token,row.lease_until,row.updated_at).run();return json({job:job(await ownJob(path[1],u))});}
   const compact=new URL(req.url).searchParams.get('format')==='compact',etag=jobEntityTag(current.id,current.version,current.updatedAt,compact);
   if(matchesEntityTag(req.headers.get('if-none-match'),etag))return new Response(null,{status:304,headers:{'Cache-Control':'private, no-store',ETag:etag}});
   return Response.json({job:compact&&current.result?{...current,result:packResult(current.result)}:current},{headers:{'Cache-Control':'private, no-store',ETag:etag}});}
  if(req.method==='POST'&&path[2]==='cancel'){await database().prepare("UPDATE jobs SET status='cancelled',message='查询已取消',updated_at=?,lease_token=NULL WHERE id=? AND owner_id=?").bind(stamp(),row.id,u).run();return json({job:job(await ownJob(path[1],u))});}
  if(req.method==='POST'&&path[2]==='recheck'){const b=await body(req),original=job(row),plan=original.result?.plans.find(p=>p.id===b.planId);if(!plan)throw new ApiError(404,'方案不存在，请重新查询');return json({job:await createJob(u,original.input,'recheck',plan)},201);}
 }
 if(p.startsWith('helper/')){const d=await runner(req,await device(req),p==='helper/claim');
  if(req.method==='POST'&&p==='helper/claim'){await body(req);await tickWatches(database(),String(d.owner_id));const lease=crypto.randomUUID(),until=new Date(Date.now()+120000).toISOString();const r=await database().prepare("UPDATE jobs SET status='running',device_id=?,lease_token=?,lease_until=?,version=version+1,message='正在查询12306',updated_at=? WHERE id=(SELECT id FROM jobs WHERE owner_id=? AND status='queued' AND (watch_id IS NULL OR EXISTS (SELECT 1 FROM watches WHERE watches.id=jobs.watch_id AND watches.status='active' AND watches.end_at>?)) ORDER BY created_at LIMIT 1) AND status='queued' RETURNING *").bind(d.id,lease,until,stamp(),d.owner_id,stamp()).first<Row>();return json({job:r?job(r):null,resumeVersion:Number(d.resume_version),...(r?{leaseToken:lease}:{})});}
  if(path[1]==='jobs'&&path[2]){const r=await database().prepare('SELECT * FROM jobs WHERE id=? AND device_id=? AND owner_id=?').bind(path[2],d.id,d.owner_id).first<Row>();if(!r)throw new ApiError(404,'任务不存在');
   if(req.method==='GET'&&path[3]==='status'){const token=req.headers.get('X-Rail-Lease-Token'),version=Number(req.headers.get('X-Rail-Job-Version'));const active=['running','waiting_user','partial'].includes(String(r.status))&&!!r.lease_token&&Date.parse(String(r.lease_until))>Date.now();if(!active)return json({cancelled:true,version:r.version});if(token!==r.lease_token||version!==r.version)throw new ApiError(409,'任务租约已失效');const renewed=await database().prepare("UPDATE jobs SET lease_until=? WHERE id=? AND device_id=? AND version=? AND lease_token=? AND lease_until>? AND status IN ('running','waiting_user','partial')").bind(new Date(Date.now()+120000).toISOString(),r.id,d.id,version,token,stamp()).run();return json({cancelled:!renewed.meta.changes,version:r.version,resumeVersion:Number(d.resume_version)});}
   if(req.method==='POST'&&['progress','result'].includes(path[3])){const parsed=helperUpdateSchema.safeParse(await body(req));if(!parsed.success)throw new ApiError(400,'助手结果格式无效');const b=parsed.data;if(r.lease_token!==b.leaseToken||r.version!==b.version||!['running','waiting_user','partial'].includes(String(r.status))||Date.parse(String(r.lease_until))<Date.now())throw new ApiError(409,'任务已失效，请重新查询');const terminal=path[3]==='result';if(terminal&&!['complete','partial','unavailable'].includes(b.status))throw new ApiError(400,'最终任务状态无效');if(!terminal&&!['running','waiting_user'].includes(b.status))throw new ApiError(400,'进度状态无效');if(b.status==='complete'&&(!b.result?.complete||!b.result.completedAt))throw new ApiError(400,'查询尚未完整完成');const currentInput=job(r).input;if(b.result){for(const p of b.result.plans){if(p.origin.code!==currentInput.origin.code||currentInput.destinations[p.destinationRank]?.code!==p.target.code||p.legs.some(l=>!currentInput.seats.includes(l.seat))||(p.kind==='long'&&!currentInput.includeLongTicket)||(p.kind==='extension'&&!currentInput.includeExtension)||(p.kind==='transfer'&&!currentInput.includeTransfer)||(p.kind==='transfer'&&(p.legs.some(l=>!l.train||!currentInput.trainTypes.includes(l.train.trainCode.charAt(0) as 'G'|'D'|'C'))||!p.transfer||p.transfer.waitMinutes<(currentInput.minTransferMinutes??45)||(currentInput.allowOvernightTransfer===false&&p.transfer.overnight)||(currentInput.transferStations?.length&&!currentInput.transferStations.some(s=>s.code===p.transfer!.station.code))))||(currentInput.sameSeatOnly&&p.legs.some(l=>l.seat!==p.legs[0].seat))||p.legs.some(l=>(currentInput.passengerCount??1)>1&&!(Number(l.inventory.count)>=(currentInput.passengerCount??1))))throw new ApiError(400,'助手方案与查询条件不一致');}if(b.result.complete){const selected=currentInput.seats;const threshold=Date.parse(currentInput.date+'T'+currentInput.earliestTime+':00+08:00');const runs=new Set(b.result.observations.filter(q=>q.from.code===currentInput.origin.code&&currentInput.destinations.some(d=>d.code===q.to.code)&&currentInput.trainTypes.includes(q.train.trainCode.charAt(0) as 'G'|'D'|'C')&&Date.parse(q.departureIso)>=threshold).map(q=>q.train.runId));const rp=job(r).recheckPlan;const unknown=b.result.observations.some(q=>r.mode==='recheck'?(rp?.legs.some(l=>(l.train?.runId??rp.train.runId)===q.train.runId&&l.from.code===q.from.code&&l.to.code===q.to.code&&(q.seats[l.seat].status==='unknown'||(q.seats[l.seat].status==='available'&&(q.seats[l.seat].count===0||((currentInput.passengerCount??1)>1&&q.seats[l.seat].count===undefined)))))):(runs.has(q.train.runId)&&selected.some(seat=>(q.seats[seat].status==='unknown'||(q.seats[seat].status==='available'&&(q.seats[seat].count===0||((currentInput.passengerCount??1)>1&&q.seats[seat].count===undefined)))))));if(unknown)throw new ApiError(400,'尚有未知余票，不能声明完整查询');}}const serializedResult=b.result?JSON.stringify(packResult(b.result)):r.result_json;if(serializedResult&&new TextEncoder().encode(String(serializedResult)).byteLength>1_900_000)throw new ApiError(413,'查询结果超过存储容量，请减少备选到站或席别');const update=await database().prepare("UPDATE jobs SET status=?,message=?,result_json=?,updated_at=?,lease_until=?,lease_token=? WHERE id=? AND lease_token=? AND version=? AND device_id=? AND owner_id=? AND lease_until>? AND status IN ('running','waiting_user','partial')").bind(b.status,b.message,serializedResult,stamp(),terminal?null:new Date(Date.now()+120000).toISOString(),terminal?null:b.leaseToken,r.id,b.leaseToken,b.version,d.id,d.owner_id,stamp()).run();if(!update.meta.changes)throw new ApiError(409,'任务已失效');await database().prepare('UPDATE devices SET message=? WHERE id=?').bind(terminal?'电脑查询助手在线':b.message,d.id).run();await watchOutcome(database(),job(r),b.status,b.message,b.result,new URL(req.url).origin);if(terminal)await pruneResultHistory(database(),String(d.owner_id));return json({ok:true});}
  }
 }
 throw new ApiError(404,'接口不存在');
 }catch(e){if(e instanceof MapServiceError)return json({error:e.message,retryAfter:e.retryAfter},e.status);if(e instanceof ApiError)return json({error:e.message},e.code);console.error('Rail API unavailable',e instanceof Error?e.name:'Error');return json({error:'查询服务暂时不可用，请稍后重试'},503);}}
