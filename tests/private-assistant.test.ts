import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {privateAssistant,privateSearch,privateAiQuota,freshPrivateJob} from '../lib/private-assistant.ts';
import {emptyMemory,intentSchema,type AiBinding} from '../cloud/public/assistant-model.ts';
import type {PrivateAssistantForm} from '../lib/private-assistant-types.ts';
import type {RailJob,TicketPlan} from '../lib/rail-types.ts';

class LocalD1{
 sqlite=new DatabaseSync(':memory:');
 constructor(){this.sqlite.exec(readFileSync('drizzle/0004_private_ai.sql','utf8'));}
 prepare(sql:string){const db=this.sqlite;return {values:[] as unknown[],bind(...values:unknown[]){this.values=values;return this;},async first(){return db.prepare(sql).get(...this.values as never[])??null;},async run(){const result=db.prepare(sql).run(...this.values as never[]);return {success:true,meta:{changes:Number(result.changes)}};}};}
}
const now=Date.now(),date=new Date(now+86400000+8*3600000).toISOString().slice(0,10);
const form:PrivateAssistantForm={origin:'杭州东',destination:'温州南',destinations:['温州南','苍南'],date,earliestTime:'06:00',passengerCount:2,seats:['second'],trainTypes:['G','D','C'],includeTransfer:true,sameSeatOnly:true,allowOvernightTransfer:true,includeLongTicket:false,includeExtension:false,middle:'',middleStations:[],minTransferMinutes:45};
const input=privateSearch(form,intentSchema.parse({}));
const train={trainNo:'test-private-only',trainCode:'G1',serviceDate:date,runId:'test@'+date},fetched=new Date(now).toISOString();
const plan:TicketPlan={id:'private-fixture',kind:'direct',train,origin:input.origin,target:input.destinations[0],destinationRank:0,departureIso:date+'T08:00:00+08:00',arrivalIso:date+'T10:00:00+08:00',legs:[{from:input.origin,to:input.destinations[0],seat:'second',inventory:{status:'available',count:5,price:120},departureIso:date+'T08:00:00+08:00',arrivalIso:date+'T10:00:00+08:00',fetchedAt:fetched,train}],route:[],shortEndIndex:1,totalPrice:120,uncovered:null,fetchedFrom:fetched,fetchedTo:fetched,relationEvidence:'unit test only',warning:null};
const job:RailJob={id:'1bc64b18-f538-4da1-b3d5-f851ed2c7905',version:2,status:'complete',input,result:{plans:[plan],observations:[],complete:true,issues:[],completedAt:fetched},message:'done',mode:'search',createdAt:fetched,updatedAt:fetched};
const body=(extra:Record<string,unknown>={})=>({message:'当前哪个方案更便宜，预算每人180',form,memory:emptyMemory(),jobId:job.id,...extra});
const request=(value:unknown,origin='https://rail.test')=>new Request('https://rail.test/api/assistant',{method:'POST',headers:{origin,'Content-Type':'application/json',Cookie:'rail_session=PRIVATE-NEVER-TO-AI'},body:JSON.stringify(value)});
function deps(ai:AiBinding,loadJob=async(_id:string,owner:string)=>{assert.equal(owner,'owner-only');return job;}){return {owner:'owner-only',ai,enabled:true,db:new LocalD1() as unknown as D1Database,loadJob};}
test('private natural language preserves multiple destinations unless a new destination is requested',()=>{
 assert.deepEqual(input.destinations.map(s=>s.name),['温州南','苍南']);
 assert.deepEqual(privateSearch(form,intentSchema.parse({destination:'温州南'})).destinations.map(s=>s.name),['温州南']);
 assert.throws(()=>privateSearch({...form,origin:'杭州市'},intentSchema.parse({})),/实际车站/);
});
test('concept comparisons explain each named option even if the model omits the topic',async()=>{
 const ai:AiBinding={run:async()=>({response:{action:'explain',topic:null}})};
 const response=await privateAssistant(request(body({message:'同车两段票和异车中转有什么区别'})),deps(ai));
 const reply=await response.json() as {answer:{text:string}};
 assert.match(reply.answer.text,/同一趟列车/);assert.match(reply.answer.text,/换乘另一趟车/);assert.match(reply.answer.text,/两张票分别购买/);assert.ok(!reply.answer.text.includes('我会检索本次'));
});
test('private assistant reads owned fresh jobs, keeps adult budgets and ignores invented route guesses on comparisons',async()=>{
 let calls=0;const ai:AiBinding={run:async(_model,value)=>{assert.ok(!JSON.stringify(value).includes('PRIVATE-NEVER-TO-AI'));calls++;return {response:calls===1?{action:'search',origin:'上海虹桥',sort:'price',maxPrice:180,budgetScope:'group'}:{references:['R1']}};}};
 const response=await privateAssistant(request(body()),deps(ai)),answer=await response.json() as {type:string;answer:{citations:{price:number;groupPrice:number}[];memory:{filters:{budgetScope:string}};sampledAt:string}};
 assert.equal(answer.type,'answer');assert.equal(answer.answer.citations[0].price,120);assert.equal(answer.answer.citations[0].groupPrice,240);assert.equal(answer.answer.memory.filters.budgetScope,'person');assert.equal(answer.answer.sampledAt,fetched);assert.equal(calls,2);
});
test('private assistant never accepts client inventory, cross-origin requests or another owner job',async()=>{
 let modelCalls=0;const ai:AiBinding={run:async()=>{modelCalls++;return {response:{}};}};
 await assert.rejects(()=>privateAssistant(request(body(),'https://foreign.test'),deps(ai)),/当前私人/);
 await assert.rejects(()=>privateAssistant(request(body({result:{plans:[{totalPrice:1}]}})),deps(ai)),/有效条件/);
 await assert.rejects(()=>privateAssistant(request(body()),deps(ai,async()=>{throw Error('not owned');})),/not owned/);
 assert.equal(modelCalls,0);
});
test('expired and failed private jobs trigger a fresh search, and cannot be analyzed as current',async()=>{
 const expired={...job,result:{...job.result!,completedAt:new Date(now-300001).toISOString()}};
 assert.equal(freshPrivateJob(expired),false);assert.equal(freshPrivateJob({...job,status:'cancelled'}),false);
 const ai:AiBinding={run:async()=>({response:{action:'compare',sort:'price'}})};
 const response=await privateAssistant(request(body()),deps(ai,async()=>expired)),value=await response.json() as {type:string};assert.equal(value.type,'search');
 await assert.rejects(()=>privateAssistant(request(body({stage:'result'})),deps(ai,async()=>expired)),/余票已过期/);
});
test('changed private form and explicit refresh cannot reuse old job facts',async()=>{
 const ai:AiBinding={run:async()=>({response:{action:'search',sort:'price'}})};
 const changed=await privateAssistant(request(body({form:{...form,passengerCount:3}})),deps(ai));assert.equal((await changed.json() as {type:string}).type,'search');
 const refresh=await privateAssistant(request(body({message:'重新查询最新余票'})),deps(ai));assert.equal((await refresh.json() as {type:string}).type,'search');
});
test('private model calls have a daily limit, one in-flight lease, and release on model failure',async()=>{
 const db=new LocalD1() as unknown as D1Database,release=await privateAiQuota(db,'owner',now);
 await assert.rejects(()=>privateAiQuota(db,'owner',now),/上一条消息/);await release();
 for(let i=1;i<30;i++){const done=await privateAiQuota(db,'owner',now);await done();}
 await assert.rejects(()=>privateAiQuota(db,'owner',now),/30 次/);
 const broken=deps({run:async()=>{throw Error('upstream');}});await assert.rejects(()=>privateAssistant(request(body()),broken),/AI 暂时不可用/);
 const released=await privateAiQuota(broken.db,'owner-only');await released();
});
