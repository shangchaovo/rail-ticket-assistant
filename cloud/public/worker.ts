import {searchRail,recheckRail} from '../../lib/rail-planner.ts';
import {planSchema} from '../../lib/rail-validation.ts';
import {searchStations} from '../../lib/station-search.ts';
import type {SearchResult} from '../../lib/rail-types.ts';
import {PublicOfficialSource} from './official-source.ts';
import {PUBLIC_LIMITS,PublicError,publicInput,publicResult,PUBLIC_DAILY_LIMIT,IP_DAILY_LIMIT} from './policy.ts';
import {acquireQuota} from './quota.ts';
import {assistantResponse,visitorId} from './assistant.ts';
import {sealEvidence} from './evidence.ts';
import type {AiBinding} from './assistant-model.ts';
import {extensionRequest,extensionApiPath,publicClientOrigin,EXTENSION_ORIGIN} from './client-origin.ts';
interface Env{ASSETS:Fetcher;PUBLIC_DB:D1Database;RATE_SALT:string;PUBLIC_ENABLED?:string;AI_ASSISTANT_ENABLED?:string;AI?:AiBinding}
const json=(value:unknown,status=200,retry=0)=>Response.json(value,{status,headers:{'Cache-Control':'no-store',...(retry?{'Retry-After':String(retry)}:{})}});
async function handle(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
 const url=new URL(request.url);
 if(request.method==='OPTIONS'&&extensionApiPath(url.pathname)){
  const method=request.headers.get('access-control-request-method');
  const headers=(request.headers.get('access-control-request-headers')??'').toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
  if(!extensionRequest(request)||!['GET','POST'].includes(method??'')||headers.some(name=>!['content-type','accept'].includes(name)))throw new PublicError(403,'扩展请求未获允许。');
  return new Response(null,{status:204});
 }
 if(request.method==='GET'&&url.pathname==='/api/public/stations')return json(searchStations(url.searchParams.get('q')||'',12));
 if(request.method==='GET'&&url.pathname==='/api/public/status')return json({enabled:env.PUBLIC_ENABLED==='true',assistantEnabled:env.AI_ASSISTANT_ENABLED==='true'&&!!env.AI,dailyLimit:PUBLIC_DAILY_LIMIT,perNetworkDailyLimit:IP_DAILY_LIMIT});
 if(url.pathname==='/api/public/assistant')return assistantResponse(request,env,ctx);
 if(url.pathname==='/api/public/query'){
  if(request.method!=='POST')return json({error:'请通过页面提交查询。'},405);
  if(env.PUBLIC_ENABLED!=='true'||!env.PUBLIC_DB||!env.RATE_SALT)throw new PublicError(503,'公开查询暂未开放，请稍后再试。');
  if(!publicClientOrigin(request))throw new PublicError(403,'请从本站页面或配套浏览器扩展发起查询。');
  if(!request.headers.get('content-type')?.startsWith('application/json')||Number(request.headers.get('content-length')||0)>100000)throw new PublicError(400,'查询格式无效。');
  const raw=await request.text();if(new TextEncoder().encode(raw).byteLength>100000)throw new PublicError(413,'查询内容过大。');
  let body:Record<string,unknown>;try{body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw Error();}catch{throw new PublicError(400,'查询内容无效。');}
  const input=publicInput(body.input);
  if(body.mode!==undefined&&!['search','recheck'].includes(String(body.mode)))throw new PublicError(400,'查询方式无效。');
  const plan=body.mode==='recheck'?planSchema.safeParse(body.plan):null;
  if(plan&&!plan.success)throw new PublicError(400,'方案无效，请重新查询。');
  const quota=await acquireQuota(env.PUBLIC_DB,await visitorId(request,env.RATE_SALT));
  const abort=new AbortController(),deadline=setTimeout(()=>abort.abort(),40000);
  const disconnect=()=>abort.abort();request.signal.addEventListener('abort',disconnect,{once:true});
  let lastResult:SearchResult|undefined;
  const stream=new ReadableStream<Uint8Array>({
   start(controller){
    const encoder=new TextEncoder();let closed=false,lastSent=0,updates=0;
    const send=(type:string,data:unknown)=>{if(!closed&&!abort.signal.aborted){try{controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));}catch{closed=true;abort.abort();}}};
    send('progress',{message:'正在从云端查询官方实时余票…',remaining:quota.remaining});
    const heartbeat=setInterval(()=>{if(!closed)try{controller.enqueue(encoder.encode(': keep-alive\n\n'));}catch{abort.abort();}},8000);
    ctx.waitUntil((async()=>{
     try{
      const source=new PublicOfficialSource({signal:abort.signal,maxRequests:16});
      const hooks={limits:PUBLIC_LIMITS,isCancelled:async()=>abort.signal.aborted,onProgress:async(result:SearchResult,message:string)=>{
       lastResult=result;
       if(updates<4&&(Date.now()-lastSent>1200||!updates&&result.plans.length>0)){lastSent=Date.now();updates++;send('progress',{message:message.replaceAll('电脑','官网'),result:publicResult({...result,observations:[]})});}
      }};
      const result=body.mode==='recheck'&&plan?.success?await recheckRail(input,plan.data,source,hooks):await searchRail(input,source,hooks);
      // A time budget is an incomplete run, even if the underlying source finishes during cancellation.
      const normalized=publicResult(abort.signal.aborted?{...result,complete:false,completedAt:new Date().toISOString(),issues:[...result.issues,'本轮已超时，已确认方案保留；其余区间尚未核验。']}:result);
      const evidenceToken=await sealEvidence(input,normalized,env.RATE_SALT);
      if(abort.signal.aborted&&!closed){try{controller.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify({result:normalized,remaining:quota.remaining,evidenceToken})}\n\n`));}catch{/* Client disconnected. */}}
      else send('result',{result:normalized,remaining:quota.remaining,evidenceToken});
     }catch{
      send('error',{message:'本轮查询未能完成，请稍后再试。',...(lastResult?{result:publicResult({...lastResult,complete:false,completedAt:new Date().toISOString()})}:{})});
     }finally{
      clearTimeout(deadline);clearInterval(heartbeat);request.signal.removeEventListener('abort',disconnect);
      await quota.release().catch(()=>{});closed=true;try{controller.close();}catch{/* Client disconnected. */}
     }
    })());
   },cancel(){abort.abort();}
  });
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'}});
 }
 if(request.method==='GET'&&(url.pathname==='/'||/^\/public-assets\/[a-z0-9.-]+$/.test(url.pathname))){
  return env.ASSETS.fetch(request);
 }
 return new Response('页面不存在',{status:404});
}
const publicWorker={async fetch(request:Request,env:Env,ctx:ExecutionContext){
 let response:Response;
 try{response=await handle(request,env,ctx);}catch(error){response=error instanceof PublicError?json({error:error.message},error.status,error.retryAfter):json({error:'查询服务暂时不可用，请稍后再试。'},503);}
 const result=new Response(response.body,response);result.headers.set('X-Content-Type-Options','nosniff');result.headers.set('Referrer-Policy','same-origin');result.headers.set('X-Frame-Options','DENY');
 if(extensionRequest(request)&&extensionApiPath(new URL(request.url).pathname)){
  result.headers.set('Access-Control-Allow-Origin',EXTENSION_ORIGIN);result.headers.set('Vary','Origin');
  result.headers.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');result.headers.set('Access-Control-Allow-Headers','Content-Type, Accept');result.headers.set('Access-Control-Max-Age','600');
 }
 result.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
 return result;
}};
export default publicWorker;
