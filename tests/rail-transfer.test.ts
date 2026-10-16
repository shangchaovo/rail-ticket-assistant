import test from 'node:test';
import assert from 'node:assert/strict';
import {searchRail,recheckRail} from '../lib/rail-planner.ts';
import {recommendPlans,recommendationLabels,previewRecommendations} from '../lib/rail-recommendation.ts';
import {helperUpdateSchema,inputSchema} from '../lib/rail-validation.ts';
import {packResult} from '../lib/rail-wire.ts';
import {purchaseLinks} from '../lib/rail-purchase.ts';
import {journeyStop,journeySegment,completeJourney} from '../lib/rail-journey.ts';
import type {Adapter,RailSearch,SegmentQuote,SeatType,Station,TicketPlan} from '../lib/rail-types';

const origin={name:'甲站',code:'AAA'},middle={name:'乙站',code:'BBB'},target={name:'丙站',code:'CCC'};
const day='2026-10-10',next='2026-10-11',fetchedAt='2026-10-09T16:00:00Z';
const input:RailSearch={origin,destinations:[target],date:day,earliestTime:'16:05',trainTypes:['G','D'],seats:['second'],includeLongTicket:false,includeExtension:false,includeTransfer:true,minTransferMinutes:45,allowOvernightTransfer:true};
function quote(from:Station,to:Station,departure:string,arrival:string,code='G1',fare:number|null=100,seat:SeatType='second',count:number|undefined=5):SegmentQuote {
  return {train:{trainNo:`internal-${code}`,trainCode:code,runId:`${day}:internal-${code}`,serviceDate:day},from,to,fromIndex:1,toIndex:2,departureIso:departure,arrivalIso:arrival,canBuy:true,
    seats:{business:{status:'unsupported',price:null},first:{status:'unsupported',price:null},second:{status:'unsupported',price:null},standing:{status:'unsupported',price:null},[seat]:{status:'available',price:fare,...(count===undefined?{}:{count})}},fetchedAt,source:'12306'};
}
const first=()=>quote(origin,middle,`${day}T16:22:00+08:00`,`${day}T22:44:00+08:00`);
const second=()=>quote(middle,target,`${next}T06:35:00+08:00`,`${next}T07:00:00+08:00`,'G2',75);
function adapter(firstRows:SegmentQuote[]=[first()],secondRows:SegmentQuote[]=[second()]) {
  const calls:string[]=[];
  const source:Adapter={transferStations:async()=>[middle],stops:async()=>{throw Error('not needed');},query:async(a,b,date)=>{
    calls.push(`${a.code}:${b.code}:${date}`);
    if(a.code===origin.code&&b.code===target.code)return [];
    if(a.code===origin.code&&b.code===middle.code)return firstRows;
    return secondRows.filter(q=>q.departureIso.slice(0,10)===date);
  }};
  return {source,calls};
}
test('direct empty does not suppress independently verified overnight transfers and each ticket uses its real boarding day',async()=>{
  const {source,calls}=adapter();const result=await searchRail(input,source);const p=result.plans[0];
  assert.equal(p.kind,'transfer');assert.equal(p.totalPrice,175);assert.equal(p.transfer?.waitMinutes,471);assert.equal(p.transfer?.overnight,true);
  assert.deepEqual(p.legs.map(l=>l.train?.trainCode),['G1','G2']);
  assert.ok(calls.includes(`BBB:CCC:${next}`));assert.equal(result.transferSearch?.scope,'limited');
  assert.deepEqual(purchaseLinks(p).map(l=>new URL(l.url).searchParams.get('date')),[day,next]);
  assert.equal(completeJourney(p),false);assert.equal(journeyStop(p,1).role,'中转 · 换乘另一趟车');assert.equal(journeySegment(p,1).legIndex,1);
  const parsed=helperUpdateSchema.parse({leaseToken:'synthetic-lease-token-valid',version:1,status:'complete',message:'done',result:packResult(result)});
  assert.deepEqual(parsed.result?.plans[0],p);
});
test('overnight disabled, missed departures, insufficient connection time and same train cannot become transfers',async()=>{
  assert.equal((await searchRail({...input,allowOvernightTransfer:false},adapter().source)).plans.length,0);
  for(const q of [quote(middle,target,`${day}T22:09:00+08:00`,`${day}T22:33:00+08:00`,'G2'),quote(middle,target,`${day}T23:00:00+08:00`,`${day}T23:30:00+08:00`,'G2'),{...second(),train:first().train}]) {
    assert.equal((await searchRail(input,adapter([first()],[q]).source)).plans.length,0);
  }
});
test('exact station and calendar day mismatches remain unknown, never substitute a same-city station',async()=>{
  const other={name:'乙北',code:'DDD'};
  const result=await searchRail(input,adapter([first()],[{...second(),from:other}]).source);
  assert.equal(result.plans.length,0);assert.equal(result.complete,false);assert.ok(result.issues.some(s=>s.includes('不匹配')));
});
test('both seats must meet group count, and same-seat rule applies across different trains',async()=>{
  const two={...input,passengerCount:2,seats:['second','first'] as SeatType[],sameSeatOnly:true};
  const secondFirst=quote(middle,target,second().departureIso,second().arrivalIso,'G2',75,'first');
  assert.equal((await searchRail(two,adapter([first()],[secondFirst]).source)).plans.length,0);
  assert.equal((await searchRail({...two,sameSeatOnly:false},adapter([first()],[secondFirst]).source)).plans.length,1);
  for(const count of [1,undefined]) {
    const q=quote(origin,middle,first().departureIso,first().arrivalIso,'G1',100,'second',count);
    if(count===undefined)delete q.seats.second.count;
    assert.equal((await searchRail(two,adapter([q]).source)).plans.length,0);
  }
});
test('fresh recheck queries both identities and removes old buyability if either segment disappears',async()=>{
  const old=(await searchRail(input,adapter().source)).plans[0];
  const {source,calls}=adapter([{...first(),fetchedAt:'2026-10-09T16:05:00Z'}],[{...second(),fetchedAt:'2026-10-09T16:05:01Z'}]);
  const fresh=await recheckRail(input,old,source);assert.equal(fresh.plans.length,1);assert.equal(calls.length,2);assert.equal(fresh.plans[0].legs[1].fetchedAt,'2026-10-09T16:05:01Z');
  assert.equal((await recheckRail(input,old,adapter([first()],[]).source)).plans.length,0);
  assert.equal((await recheckRail({...input,origin:{name:'别站',code:'DDD'}},old,adapter().source)).plans.length,0);
});
test('limits stop later requests and preserve already confirmed transfer plans',async()=>{
  const {source,calls}=adapter();const baseQuery=source.query;
  source.transferStations=async()=>[middle,{name:'丁站',code:'DDD'}];
  source.query=async(a,b,date)=>{if(b.code==='DDD')throw Object.assign(new Error('rate'),{name:'SourceError',code:'rate'});return baseQuery(a,b,date);};
  const result=await searchRail(input,source);assert.equal(result.plans.length,1);assert.equal(result.complete,false);assert.ok(result.issues.some(s=>s.includes('限流')));assert.ok(calls.length<60);
});
test('a later calendar day hitting a limit preserves this hub’s already published connection',async()=>{
  const sameDay=quote(middle,target,`${day}T23:35:00+08:00`,`${day}T23:59:00+08:00`,'G2',75);
  const {source}=adapter([first()],[sameDay]);const baseQuery=source.query;
  source.query=async(a,b,date)=>{if(a.code===middle.code&&date===next)throw Object.assign(new Error('rate'),{name:'SourceError',code:'rate'});return baseQuery(a,b,date);};
  const result=await searchRail(input,source);
  assert.equal(result.plans.length,1);assert.equal(result.plans[0].transfer?.overnight,false);assert.equal(result.complete,false);
  assert.equal(result.transferSearch?.checked,2);assert.ok(result.issues.some(s=>s.includes('限流')));
});
test('unknown total fare stays null, rejects forged connection, identity and totals in packed uploads',async()=>{
  const result=await searchRail(input,adapter([first()],[{...second(),seats:{...second().seats,second:{status:'available',price:null,count:5}}}]).source);
  assert.equal(result.plans[0].totalPrice,null);
  const upload=(plans:TicketPlan[])=>helperUpdateSchema.safeParse({leaseToken:'synthetic-lease-token-valid',version:1,status:'complete',message:'done',result:packResult({...result,plans})}).success;
  assert.equal(upload(result.plans),true);
  assert.equal(upload([{...result.plans[0],totalPrice:0}]),false);
  assert.equal(upload([{...result.plans[0],transfer:{...result.plans[0].transfer!,station:target}}]),false);
  assert.equal(upload([{...result.plans[0],legs:result.plans[0].legs.map(l=>({...l,train:undefined}))}]),false);
});
test('price/time ranking preserves cheap, fast and compromise choices while unknown fare gets no low-price label',async()=>{
  const p=(await searchRail(input,adapter().source)).plans[0];
  const clone=(id:string,price:number|null,hours:number)=>({...p,id,totalPrice:price,arrivalIso:new Date(Date.parse(p.departureIso)+hours*3600_000).toISOString()} as TicketPlan);
  const cheap=clone('cheap',100,10),fast=clone('fast',300,5),balanced=clone('balanced',160,6),dominated=clone('dominated',250,9),unknown=clone('unknown',null,4);
  const plans=[dominated,unknown,fast,cheap,balanced];
  assert.equal(recommendPlans(plans)[0].id,'balanced');assert.equal(recommendPlans(plans,'price')[0].id,'cheap');assert.equal(recommendPlans(plans,'duration')[0].id,'unknown');
  assert.ok(recommendPlans(plans).findIndex(p=>p.id==='dominated')>recommendPlans(plans).findIndex(p=>p.id==='balanced'));
  assert.ok(!recommendationLabels(plans).unknown?.includes('本次较省'));
  const many=[cheap,balanced,...Array.from({length:6},(_,i)=>clone('middle-'+i,170+i*10,6.1+i*.1)),fast];
  const preview=previewRecommendations(recommendPlans(many));
  assert.equal(preview.length,6);assert.ok(preview.some(p=>p.id==='cheap'));assert.ok(preview.some(p=>p.id==='fast'));assert.equal(preview[0].id,'balanced');
});
test('input validates transfer bounds and duplicate actual stations',()=>{
  const future={...input,date:new Date(Date.now()+86400000).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})};
  assert.equal(inputSchema.safeParse({...future,transferStations:[middle]}).success,true);
  for(const extra of [{minTransferMinutes:0},{transferStations:[middle,middle]},{transferStations:[origin]}])assert.equal(inputSchema.safeParse({...future,...extra}).success,false);
});
