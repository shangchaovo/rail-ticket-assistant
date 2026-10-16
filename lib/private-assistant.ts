import {z} from 'zod';
import {draftSchema,memorySchema,emptyMemory,understand,intentSchema,explicitTimeBounds,explicitBudgetScope,type AiBinding,type AssistantIntent} from '../cloud/public/assistant-model.ts';
import {explainQuestion,explicitRefresh,preferenceQuestion,updateMemory,groundedAnswer} from '../cloud/public/assistant.ts';
import {collectEvidence} from '../cloud/public/evidence.ts';
import {PublicError} from '../cloud/public/policy.ts';
import {inputSchema} from './rail-validation.ts';
import {searchStations} from './station-search.ts';
import {INVENTORY_FRESH_MS} from './rail-freshness.ts';
import {sameOrigin} from './private-auth.ts';
import type {RailJob,RailSearch,Station} from './rail-types.ts';
import type {PrivateAssistantForm,PrivateAssistantReply} from './private-assistant-types.ts';

const formSchema=draftSchema.extend({destinations:z.array(z.string().trim().max(40)).min(1).max(8),middleStations:z.array(z.string().trim().max(40)).max(3)});
const requestSchema=z.object({stage:z.enum(['message','result']).default('message'),message:z.string().trim().min(1).max(600),history:z.array(z.string().max(600)).max(3).default([]),form:formSchema,memory:memorySchema.optional(),jobId:z.string().uuid().optional()}).strict();
const active=new Set(['queued','running','waiting_user']);
function station(name:string):Station{
 const exact=searchStations(name,6).stations.find(s=>s.name===name);
 if(!exact)throw new PublicError(400,`请明确“${name||'未填写'}”对应的实际车站，再发送需求。`);
 return {name:exact.name,code:exact.code};
}
export function privateSearch(form:PrivateAssistantForm,intent:AssistantIntent):RailSearch{
 const targets=intent.destination?[intent.destination]:form.destinations;
 const middles=intent.middle?[intent.middle]:form.middleStations;
 const parsed=inputSchema.safeParse({origin:station(intent.origin??form.origin),destinations:targets.map(station),date:intent.date??form.date,earliestTime:intent.earliestTime??form.earliestTime,
  trainTypes:form.trainTypes,seats:intent.seats??form.seats,passengerCount:intent.passengerCount??form.passengerCount,sameSeatOnly:form.sameSeatOnly,
  includeLongTicket:form.includeLongTicket,includeExtension:form.includeExtension,includeTransfer:intent.includeTransfer??form.includeTransfer,transferStations:middles.map(station),minTransferMinutes:form.minTransferMinutes,allowOvernightTransfer:intent.allowOvernight??form.allowOvernightTransfer});
 if(!parsed.success)throw new PublicError(400,parsed.error.issues[0]?.message??'查询条件无效。');
 return parsed.data;
}
function key(input:RailSearch){return JSON.stringify([input.origin.code,input.destinations.map(s=>s.code),input.date,input.earliestTime,input.trainTypes,input.seats,input.passengerCount??1,input.sameSeatOnly??true,input.includeLongTicket,input.includeExtension,input.includeTransfer??false,input.transferStations?.map(s=>s.code)??[],input.minTransferMinutes??45,input.allowOvernightTransfer??true]);}
export function freshPrivateJob(job:RailJob,now=Date.now()){
 const at=Date.parse(job.result?.completedAt??'');
 return !!job.result&&!active.has(job.status)&&!['unavailable','cancelled'].includes(job.status)&&Number.isFinite(at)&&at<=now+30000&&now-at<INVENTORY_FRESH_MS;
}
function snapshot(job:RailJob){
 const evidence=collectEvidence(job.input,job.result!);
 return {...evidence,at:Date.parse(job.result!.completedAt!)};
}
export async function privateAiQuota(db:D1Database,owner:string,now=Date.now()){
 const day=new Date(now+8*3600000).toISOString().slice(0,10),lease=crypto.randomUUID();
 const row=await db.prepare('INSERT INTO private_ai_limits (owner_id,day,calls,busy_until,lease_id) VALUES (?,?,1,?,?) ON CONFLICT(owner_id,day) DO UPDATE SET calls=calls+1,busy_until=excluded.busy_until,lease_id=excluded.lease_id WHERE calls<30 AND busy_until<=? RETURNING calls').bind(owner,day,now+55000,lease,now).first();
 if(!row)throw new PublicError(429,'AI 正在处理上一条消息，或今日私人工作台的 30 次解读额度已用完；仍可使用条件查询。');
 return async()=>{await db.prepare('UPDATE private_ai_limits SET busy_until=0 WHERE owner_id=? AND day=? AND lease_id=?').bind(owner,day,lease).run();};
}
interface Dependencies{ai?:AiBinding;enabled:boolean;owner:string;db:D1Database;loadJob:(id:string,owner:string)=>Promise<RailJob>}
/** Authenticated caller is supplied by dispatch; facts are always read from that owner's database job. */
export async function privateAssistant(request:Request,deps:Dependencies):Promise<Response>{
 if(!sameOrigin(request))throw new PublicError(403,'请从当前私人工作台发送消息。');
 if(!deps.enabled||!deps.ai)throw new PublicError(503,'私人 AI 助手暂不可用，仍可使用条件查询。');
 if(!request.headers.get('content-type')?.startsWith('application/json')||Number(request.headers.get('content-length')||0)>16000)throw new PublicError(400,'消息格式无效或内容过长。');
 const raw=await request.text();if(new TextEncoder().encode(raw).byteLength>16000)throw new PublicError(413,'消息过长，请缩短需求。');
 let data:unknown;try{data=JSON.parse(raw);}catch{throw new PublicError(400,'消息格式无效。');}
 const parsed=requestSchema.safeParse(data);if(!parsed.success)throw new PublicError(400,'请填写有效条件，消息最多 600 字。');
 const body=parsed.data,memory=body.memory??emptyMemory();
 // Do the ownership lookup before inference, even when the question is only explanatory.
 const job=body.jobId?await deps.loadJob(body.jobId,deps.owner):null;
 const release=await privateAiQuota(deps.db,deps.owner),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),48000);
 const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});
 try{
  let reply:PrivateAssistantReply;
  if(body.stage==='result'){
   if(!job||!freshPrivateJob(job))throw new PublicError(409,'本轮尚未完成或余票已过期，请重新查询后再比较。');
   reply={type:'answer',answer:await groundedAnswer(deps.ai,snapshot(job),memory,controller.signal,body.message)};
  }else{
   const intent=await understand(deps.ai,body.message,body.history,body.form,memory,controller.signal);
   if(intent.action==='unsupported')reply={type:'answer',answer:{text:'我能查询本工作台的实时余票，比较票价与总用时、解释票段。我不代购、不提交候补、不处理验证码。',citations:[],memory,retrieved:0}};
   else if(intent.action==='explain')reply={type:'answer',answer:{text:explainQuestion(body.message,intent.topic),citations:[],memory,retrieved:0}};
   else{
    const preferencesOnly=preferenceQuestion(body.message);
    const input=privateSearch(body.form,preferencesOnly?intentSchema.parse({}):intent),changed=!!job&&key(input)!==key(job.input);
    const checked=explicitBudgetScope(body.message,explicitTimeBounds(body.message,{...intent,date:input.date},input.date));
    if(preferencesOnly){if(!/到达|前到|抵达|最晚|最迟|早到/.test(body.message))checked.latestArrival=null;if(/预算不变|预算照旧|原预算/.test(body.message)){checked.maxPrice=null;checked.budgetScope=null;checked.clearFilters=false;}}
    const nextMemory=updateMemory(memory,checked,changed);
    if(job&&!changed&&freshPrivateJob(job)&&!explicitRefresh(body.message))reply={type:'answer',answer:await groundedAnswer(deps.ai,snapshot(job),nextMemory,controller.signal,body.message)};
    else reply={type:'search',input,memory:nextMemory};
   }
  }
  return Response.json(reply,{headers:{'Cache-Control':'private, no-store'}});
 }finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);await release();}
}
