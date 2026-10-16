import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {PublicOfficialSource} from '../cloud/public/official-source.ts';
import {publicInput,dailyWindow} from '../cloud/public/policy.ts';
import {acquireQuota} from '../cloud/public/quota.ts';
import worker from '../cloud/public/worker.ts';
import {searchRail} from '../lib/rail-planner.ts';
import type {RailSearch,SegmentQuote} from '../lib/rail-types.ts';
class LocalD1{
 sqlite=new DatabaseSync(':memory:');
 constructor(){this.sqlite.exec(readFileSync('cloud/public/schema.sql','utf8'));}
 prepare(sql:string){const db=this.sqlite;return {values:[] as unknown[],bind(...values:unknown[]){this.values=values;return this;},async first(){return db.prepare(sql).get(...this.values as never[])??null;},async run(){const out=db.prepare(sql).run(...this.values as never[]);return {success:true,meta:{changes:Number(out.changes)}};}};}
 async batch(statements:ReturnType<LocalD1['prepare']>[]){this.sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());this.sqlite.exec('COMMIT');return results;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
}
const from={name:'杭州东',code:'HGH'},to={name:'温州南',code:'VRH'};
const date=new Date(Date.now()+86400000+8*3600000).toISOString().slice(0,10);
const input:RailSearch={origin:from,destinations:[to],date,earliestTime:'00:00',trainTypes:['G'],seats:['second'],includeTransfer:false,includeExtension:false,includeLongTicket:false,passengerCount:1,sameSeatOnly:true};
function payload(){const fields=Array.from({length:40},()=> '');Object.assign(fields,{1:'预订',2:'TESTG1',3:'G1',6:from.code,7:to.code,8:'10:00',9:'11:00',10:'01:00',11:'Y',13:date.replaceAll('-',''),16:'01',17:'02',30:'5',39:'O001000005'});return {status:true,data:{result:[fields.join('|')],map:{HGH:from.name,VRH:to.name}}};}
const requestLog:{url:string;cookie:string|null}[]=[];
const fixtureFetch=async(url:RequestInfo|URL,options?:RequestInit)=>{
 requestLog.push({url:String(url),cookie:new Headers(options?.headers).get('cookie')});
 if(String(url).endsWith('/init'))return new Response("var CLeftTicketUrl = 'leftTicket/queryG';",{headers:{'set-cookie':'anonymous_guest=fixture; Path=/'}});
 if(String(url).includes('czxx'))return Response.json({status:true,data:{data:[]}});
 return Response.json(payload());
};
test('public input accepts only canonical stations and a bounded single-destination date range',()=>{
 assert.deepEqual(publicInput(input),input);
 for(const changed of [{origin:{...from,name:'假车站'}},{destinations:[to,{name:'温州北',code:'WDU'}]},{date:'2100-01-01'},{transferStations:[to]}])assert.throws(()=>publicInput({...input,...changed}));
 assert.equal(dailyWindow(Date.parse('2026-10-15T15:59:59Z')),'2026-10-15');assert.equal(dailyWindow(Date.parse('2026-10-15T16:00:00Z')),'2026-10-16');
});
test('cloud source creates an anonymous cookie jar and parses only the requested real stations',async()=>{
 requestLog.length=0;const source=new PublicOfficialSource({fetcher:fixtureFetch as typeof fetch,gapMs:0});
 const quotes=await source.query(from,to,date);assert.equal(quotes.length,1);assert.equal(quotes[0].seats.second.price,10);
 assert.equal(requestLog[0].cookie,null);assert.equal(requestLog[1].cookie,'anonymous_guest=fixture');assert.ok(requestLog.every(r=>new URL(r.url).hostname==='kyfw.12306.cn'));
});
test('verification, rate limits and request budgets stop the source without a retry',async()=>{
 for(const status of [403,429]){let calls=0;const source=new PublicOfficialSource({gapMs:0,fetcher:async()=>{calls++;return new Response('',{status});}});await assert.rejects(source.query(from,to,date));await assert.rejects(source.query(from,to,date));assert.equal(calls,1);}
 const source=new PublicOfficialSource({fetcher:fixtureFetch as typeof fetch,gapMs:0,maxRequests:1});await assert.rejects(source.query(from,to,date),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='budget');
});
test('public quotas limit global concurrency, per-network daily use and global daily use',async()=>{
 const local=new LocalD1(),db=local as unknown as D1Database,now=Date.now();
 const a=await acquireQuota(db,'a',now),b=await acquireQuota(db,'b',now);await assert.rejects(acquireQuota(db,'c',now),/正在查询/);await a.release();await b.release();
 for(let i=0;i<20;i++){const q=await acquireQuota(db,'limited',now+i*11000);await q.release();}
 await assert.rejects(acquireQuota(db,'limited',now+250000),/次数已用完/);
 local.sqlite.prepare("UPDATE public_limits SET used=100 WHERE scope='global'").run();await assert.rejects(acquireQuota(db,'new',now+300000),/公开查询名额已用完/);
 assert.equal((local.sqlite.prepare('SELECT COUNT(*) AS n FROM public_leases').get() as {n:number}).n,0);
});
test('public worker rejects cross-origin posts, malformed stations, and private/admin routes',async()=>{
 const local=new LocalD1();const env={PUBLIC_DB:local as unknown as D1Database,PUBLIC_ENABLED:'true',RATE_SALT:'test-only-salt',ASSETS:{fetch:async()=>new Response('asset')}} as never;const ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
 for(const path of ['/api/device','/api/helper/claim','/api/jobs/private-job','/downloads/rail-helper.zip'])assert.equal((await worker.fetch(new Request('https://local.test'+path),env,ctx)).status,404);
 const r=await worker.fetch(new Request('https://local.test/api/public/query',{method:'POST',headers:{Origin:'https://foreign.test','Content-Type':'application/json'},body:JSON.stringify({input})}),env,ctx);assert.equal(r.status,403);
 const bad=await worker.fetch(new Request('https://local.test/api/public/query',{method:'POST',headers:{Origin:'https://local.test','Content-Type':'application/json'},body:JSON.stringify({input:{...input,origin:{name:'错误站',code:'HGH'}}})}),env,ctx);assert.equal(bad.status,400);
 assert.equal((local.sqlite.prepare('SELECT COUNT(*) AS n FROM public_limits').get() as {n:number}).n,0);
});
test('public streamed query keeps normalized fresh results and never forwards the private login cookie',async()=>{
 const original=globalThis.fetch;requestLog.length=0;globalThis.fetch=fixtureFetch as typeof fetch;
 try{
 const local=new LocalD1(),pending:Promise<unknown>[]=[];const env={PUBLIC_DB:local as unknown as D1Database,PUBLIC_ENABLED:'true',RATE_SALT:'test-only-salt',ASSETS:{fetch:async()=>new Response('asset')}} as never;const ctx={waitUntil:(p:Promise<unknown>)=>pending.push(p)} as unknown as ExecutionContext;
 const response=await worker.fetch(new Request('https://local.test/api/public/query',{method:'POST',headers:{Origin:'https://local.test','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1',Cookie:'rail_session=PRIVATE_MARKER_MUST_NEVER_LEAVE'},body:JSON.stringify({input})}),env,ctx);
 assert.equal(response.status,200);const text=await response.text();await Promise.all(pending);assert.ok(text.includes('event: result'));assert.ok(text.includes('TESTG1'));assert.ok(!text.includes('PRIVATE_MARKER'));assert.ok(requestLog.every(r=>!r.cookie?.includes('PRIVATE_MARKER')));assert.equal((local.sqlite.prepare('SELECT COUNT(*) AS n FROM public_leases').get() as {n:number}).n,0);
 }finally{globalThis.fetch=original;}
});
test('smaller cloud planning limits preserve confirmed direct tickets and stop further requests',async()=>{
 const first=await new PublicOfficialSource({fetcher:fixtureFetch as typeof fetch,gapMs:0}).query(from,to,date);let calls=0;
 const result=await searchRail(input,{query:async()=>{calls++;return first;},stops:async()=>{calls++;return [];}},{limits:{requests:1,expandedRuns:1,splitStops:1}});
 assert.equal(calls,1);assert.equal(result.plans.length,1);assert.equal(result.complete,false);assert.ok(result.issues.some(s=>s.includes('1 次官方查询预算')));
 const q:SegmentQuote=first[0];assert.equal(q.train.serviceDate,date);
});
