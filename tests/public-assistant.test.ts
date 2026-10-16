import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {sealEvidence,openEvidence} from '../cloud/public/evidence.ts';
import {emptyMemory,intentSchema,modelJSON,explicitTimeBounds,explicitBudgetScope,type AiBinding} from '../cloud/public/assistant-model.ts';
import {retrieveEvidence,resolveSearch,updateMemory,groundedAnswer,preferenceQuestion,explicitRefresh} from '../cloud/public/assistant.ts';
import {acquireQuota,consumeQueryQuota} from '../cloud/public/quota.ts';
import worker from '../cloud/public/worker.ts';
import type {RailSearch,SearchResult,TicketPlan} from '../lib/rail-types.ts';
import type {FormDraft} from '../cloud/public/assistant-types.ts';

class LocalD1{
 sqlite=new DatabaseSync(':memory:');
 constructor(){this.sqlite.exec(readFileSync('cloud/public/schema.sql','utf8'));}
 prepare(sql:string){const db=this.sqlite;return {values:[] as unknown[],bind(...values:unknown[]){this.values=values;return this;},async first(){return db.prepare(sql).get(...this.values as never[])??null;},async run(){const result=db.prepare(sql).run(...this.values as never[]);return {success:true,meta:{changes:Number(result.changes)}};}};}
 async batch(statements:ReturnType<LocalD1['prepare']>[]){for(const s of statements)await s.run();return [];}
}
const date=new Date(Date.now()+86400000+8*3600000).toISOString().slice(0,10),now=Date.now();
const origin={name:'杭州东',code:'HGH'},target={name:'温州南',code:'VRH'};
const input:RailSearch={origin,destinations:[target],date,earliestTime:'06:00',trainTypes:['G'],seats:['second'],includeLongTicket:false,includeExtension:false,passengerCount:2,sameSeatOnly:true,includeTransfer:false,transferStations:[],minTransferMinutes:45,allowOvernightTransfer:false};
const form:FormDraft={origin:origin.name,destination:target.name,date,earliestTime:'06:00',passengerCount:2,trainTypes:['G'],seats:['second'],includeTransfer:false,sameSeatOnly:true,allowOvernightTransfer:false,includeLongTicket:false,includeExtension:false,middle:'',minTransferMinutes:45};
function plan(id:string,price:number|null,end='10:00'):TicketPlan{
 const departureIso=date+'T08:00:00+08:00',arrivalIso=date+'T'+end+':00+08:00',fetchedAt=new Date(now).toISOString(),train={trainNo:id,trainCode:'G'+id,serviceDate:date,runId:id+'@'+date};
 return {id,kind:'direct',train,origin,target,destinationRank:0,departureIso,arrivalIso,legs:[{from:origin,to:target,seat:'second',inventory:{status:'available',count:5,price},departureIso,arrivalIso,fetchedAt,train}],route:[],shortEndIndex:1,totalPrice:price,uncovered:null,fetchedFrom:fetchedAt,fetchedTo:fetchedAt,relationEvidence:'unit-test-only',warning:null};
}
const result:SearchResult={plans:[plan('1',100,'11:00'),plan('2',160,'09:00'),plan('3',130,'10:00'),plan('4',null,'08:40')],observations:[],complete:true,issues:[],completedAt:new Date(now).toISOString()};
const ai=(response:unknown):AiBinding=>({run:async()=>({response})});
test('explicit arrival deadlines cannot silently become departure constraints',()=>{
 assert.equal(explicitBudgetScope('预算每人180元',intentSchema.parse({budgetScope:'group'})).budgetScope,'person');assert.equal(explicitBudgetScope('两个人一共300以内',intentSchema.parse({budgetScope:'person'})).budgetScope,'group');assert.equal(explicitBudgetScope('预算不变',intentSchema.parse({budgetScope:'group'})).budgetScope,null);
 assert.equal(preferenceQuestion('那就先看最快的，预算不变'),true);assert.equal(explicitRefresh('那就先看最快的，预算不变'),false);assert.equal(preferenceQuestion('改成明天，便宜优先'),false);assert.equal(explicitRefresh('重新查一下最新余票'),true);
 const mistaken=intentSchema.parse({action:'search',date,earliestTime:'18:00'});
 const fixed=explicitTimeBounds('18点前到，两个人总共300以内',mistaken,date);assert.equal(fixed.earliestTime,null);assert.equal(fixed.latestArrival,date+'T18:00:00+08:00');
 const both=explicitTimeBounds('下午三点半出发，晚上八点前到',mistaken,date);assert.equal(both.earliestTime,'15:30');assert.equal(both.latestArrival,date+'T20:00:00+08:00');
 const next=explicitTimeBounds('第二天上午9点前到',mistaken,date);assert.ok(Date.parse(next.latestArrival!)>Date.parse(date+'T23:59:59+08:00'));
 const minutePrecision=intentSchema.parse({latestArrival:date+'T18:00+08:00',clearFilters:null});assert.equal(minutePrecision.latestArrival,date+'T18:00:00+08:00');assert.equal(minutePrecision.clearFilters,false);
});
test('signed evidence rejects forged fares, wrong keys, expired inventory and expired receipts',async()=>{
 const token=await sealEvidence(input,result,'test-only-key',now),snapshot=await openEvidence(token,'test-only-key',now);assert.equal(snapshot?.plans.length,4);
 assert.equal(await openEvidence(token,'other-key',now),null);assert.equal(await openEvidence(token,'test-only-key',now+300001),null);
 const parts=token.split('.');parts[0]=parts[0].slice(0,-1)+(parts[0].endsWith('A')?'B':'A');assert.equal(await openEvidence(parts.join('.'),'test-only-key',now),null);
 const stale={...result,plans:result.plans.map(p=>({...p,legs:p.legs.map(l=>({...l,fetchedAt:new Date(now-300001).toISOString()}))}))};
 const expired=await openEvidence(await sealEvidence(input,stale,'key',now),'key',now);assert.equal(expired?.plans.length,0);
});
test('retrieval uses actual prices, all-adult budget, total time and arrival constraints',async()=>{
 const snapshot=(await openEvidence(await sealEvidence(input,result,'key',now),'key',now))!;
 const memory=emptyMemory();memory.sort='price';memory.filters.maxPrice=270;memory.filters.budgetScope='group';
 assert.deepEqual(retrieveEvidence(snapshot,memory).ordered.map(p=>p.id),['1','3']);
 memory.filters.latestArrival=date+'T10:00:00+08:00';assert.deepEqual(retrieveEvidence(snapshot,memory).ordered.map(p=>p.id),['3']);
 memory.filters.maxDuration=100;assert.equal(retrieveEvidence(snapshot,memory).ordered.length,0);
 const all=retrieveEvidence(snapshot,emptyMemory());assert.ok(all.retrieved.some(p=>p.id==='1'));assert.ok(all.retrieved.some(p=>p.id==='4'));
});
test('AI intents resolve only real stations and preserve explicit conditions across follow-ups',()=>{
 const intent=intentSchema.parse({action:'search',origin:'温州南',destination:'香港西九龙',passengerCount:2,sort:'price'});
 assert.equal(resolveSearch(form,intent).destinations[0].name,'香港西九龙');
 assert.throws(()=>resolveSearch(form,{...intent,origin:'不存在的高铁站'}),/实际车站/);
 const previous=emptyMemory();previous.filters.maxPrice=300;previous.filters.budgetScope='group';
 const follow=updateMemory(previous,intentSchema.parse({action:'compare',sort:'duration'}));assert.equal(follow.filters.maxPrice,300);assert.equal(follow.filters.budgetScope,'group');assert.equal(follow.sort,'duration');
 assert.equal(updateMemory(previous,intentSchema.parse({}),true).filters.maxPrice,null);
});
test('grounded generation cannot invent a train, fare or reference and handles model failures',async()=>{
 const snapshot=(await openEvidence(await sealEvidence(input,result,'key',now),'key',now))!;
 const answer=await groundedAnswer(ai({references:['R1','R2'],price:0,train:'G99999999'}),snapshot,{...emptyMemory(),sort:'price'},new AbortController().signal,'哪个更便宜');
 assert.equal(answer.citations[0].id,'1');assert.equal(answer.citations[0].price,100);assert.equal(answer.citations[0].groupPrice,200);assert.ok(!answer.text.includes('G99999999'));
 const single=await groundedAnswer(ai({references:['R1','R2']}),snapshot,{...emptyMemory(),sort:'price'},new AbortController().signal,'只推荐一个最便宜的方案');assert.equal(single.citations.length,1);assert.equal(single.citations[0].id,'1');
 const bad=await groundedAnswer(ai({references:['R99']}),snapshot,emptyMemory(),new AbortController().signal,'比较');assert.equal(bad.degraded,true);assert.ok(bad.citations.every(c=>snapshot.plans.some(p=>p.id===c.id)));
 const expired={...snapshot,exp:Date.now()-1};assert.equal((await groundedAnswer(ai({references:['R1']}),expired,emptyMemory(),new AbortController().signal,'比较')).citations.length,0);
 assert.deepEqual(modelJSON({choices:[{message:{content:'```json\n{"ok":true}\n```'}}]}),{ok:true});
});
test('AI budgets share concurrency with normal queries and charge fresh official searches separately',async()=>{
 const local=new LocalD1(),db=local as unknown as D1Database;
 const chat=await acquireQuota(db,'same-network',now,'assistant');await assert.rejects(acquireQuota(db,'same-network',now),/正在查询/);
 await consumeQueryQuota(db,'same-network',now);await chat.release();
 assert.equal((local.sqlite.prepare("SELECT used FROM public_limits WHERE scope='ai:global'").get() as {used:number}).used,1);
 assert.equal((local.sqlite.prepare("SELECT used FROM public_limits WHERE scope='global'").get() as {used:number}).used,1);
 for(let i=1;i<15;i++){const item=await acquireQuota(db,'same-network',now+i*11000,'assistant');await item.release();}
 await assert.rejects(acquireQuota(db,'same-network',now+200000,'assistant'),/AI 对话/);
});
test('assistant rejects cross-site messages and invalid data before inference or quota use',async()=>{
 const local=new LocalD1();let calls=0;const env={PUBLIC_ENABLED:'true',AI_ASSISTANT_ENABLED:'true',AI:{run:async()=>{calls++;return {response:{}};}},PUBLIC_DB:local,RATE_SALT:'unit-key'} as never,ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
 const origins:Record<string,string>[]=[{Origin:'https://other.test','Content-Type':'application/json'},{'Content-Type':'application/json'}];
 for(const headers of origins)assert.equal((await worker.fetch(new Request('https://site.test/api/public/assistant',{method:'POST',headers,body:JSON.stringify({message:'查询',form})}),env,ctx)).status,403);
 const response=await worker.fetch(new Request('https://site.test/api/public/assistant',{method:'POST',headers:{Origin:'https://site.test','Content-Type':'application/json'},body:JSON.stringify({message:'x'.repeat(601),form})}),env,ctx);assert.equal(response.status,400);assert.equal(calls,0);assert.equal((local.sqlite.prepare('SELECT COUNT(*) AS n FROM public_limits').get() as {n:number}).n,0);
});
test('a conversational comparison retrieves signed live facts without re-querying or leaking browser credentials',async()=>{
 const local=new LocalD1(),pending:Promise<unknown>[]=[],token=await sealEvidence(input,result,'unit-key');let calls=0;const modelPrompts:string[]=[];
 const env={PUBLIC_ENABLED:'true',AI_ASSISTANT_ENABLED:'true',AI:{run:async(_model:string,args:Record<string,unknown>)=>{modelPrompts.push(JSON.stringify(args));calls++;return {response:calls===1?{action:'search',origin:'温州南',sort:'price',maxPrice:270,budgetScope:'group'}:{references:['R1','R2']}};}},PUBLIC_DB:local,RATE_SALT:'unit-key'} as never;
 const response=await worker.fetch(new Request('https://site.test/api/public/assistant',{method:'POST',headers:{Origin:'https://site.test','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1',Cookie:'rail_session=PRIVATE_COOKIE_MARKER'},body:JSON.stringify({message:'总预算270以内，便宜优先',form,evidenceToken:token})}),env,{waitUntil:(p:Promise<unknown>)=>pending.push(p)} as unknown as ExecutionContext);
 assert.equal(response.status,200);const text=await response.text();await Promise.all(pending);assert.ok(text.includes('"type":"answer"'));assert.ok(!text.includes('"type":"search"'));assert.ok(text.includes('"groupPrice":200'));assert.ok(text.includes('依据')||text.includes('已按'));assert.equal(calls,2);assert.ok(modelPrompts.every(p=>!p.includes('PRIVATE_COOKIE_MARKER')));assert.equal(local.sqlite.prepare("SELECT used FROM public_limits WHERE scope='global'").get(),undefined);
 assert.equal((local.sqlite.prepare('SELECT COUNT(*) AS n FROM public_leases').get() as {n:number}).n,0);
});
