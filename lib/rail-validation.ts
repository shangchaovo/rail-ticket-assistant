import { z } from 'zod';
import {unpackResult} from './rail-wire.ts';
const station=z.object({name:z.string().min(1).max(40),code:z.string().regex(/^[A-Z]{3}$/)});
const iso=z.string().datetime({offset:true});
const identity=z.object({trainNo:z.string().min(1).max(80),serviceDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),trainCode:z.string().min(1).max(30),runId:z.string().min(1).max(150),relationEvidence:z.string().max(250).optional()});
const inventory=z.object({status:z.enum(['available','sold_out','waitlist','not_on_sale','unsupported','unknown']),count:z.number().int().nonnegative().max(100000).optional(),price:z.number().nonnegative().max(100000).nullable()});
const seat=z.enum(['business','first','second','standing']);
const stop=z.object({station,index:z.number().int().nonnegative(),arrivalIso:iso.nullable(),departureIso:iso.nullable()});
const leg=z.object({from:station,to:station,seat,inventory,departureIso:iso,arrivalIso:iso,fetchedAt:iso,train:identity.optional(),route:z.array(stop).max(200).optional()});
const quote=z.object({train:identity,from:station,to:station,fromIndex:z.number().int().nonnegative(),toIndex:z.number().int().nonnegative(),departureIso:iso,arrivalIso:iso,canBuy:z.boolean(),seats:z.object({business:inventory,first:inventory,second:inventory,standing:inventory}),fetchedAt:iso,source:z.literal('12306')});
const planBase=z.object({id:z.string().max(500),kind:z.enum(['direct','split','long','extension','transfer']),train:identity,origin:station,target:station,destinationRank:z.number().int().nonnegative(),departureIso:iso,arrivalIso:iso,legs:z.array(leg).min(1).max(2),route:z.array(stop).max(200),shortEndIndex:z.number().int(),totalPrice:z.number().nonnegative().nullable(),uncovered:z.object({from:station,to:station}).nullable(),fetchedFrom:iso,fetchedTo:iso,relationEvidence:z.string().max(500),warning:z.string().max(1000).nullable(),transfer:z.object({station,waitMinutes:z.number().min(20).max(960),overnight:z.boolean(),minMinutes:z.number().int().min(20).max(180)}).optional()});
const sellable=(p:z.infer<typeof planBase>|Omit<z.infer<typeof planBase>,'route'>,c:z.RefinementCtx)=>{
 if(p.legs.some(l=>l.inventory.status!=='available'||l.inventory.count===0))c.addIssue({code:z.ZodIssueCode.custom,message:'方案包含尚未确认可售的票段'});
 if(p.kind!=='transfer')return;
 const [first,second]=p.legs;
 const date=(value:string)=>Number.isFinite(Date.parse(value))?new Date(Date.parse(value)+8*3600_000).toISOString().slice(0,10):'';
 const wait=second?(Date.parse(second.departureIso)-Date.parse(first.arrivalIso))/60_000:NaN;
 const total=(Date.parse(p.arrivalIso)-Date.parse(p.departureIso))/60_000;
 if(!second||!first.train||!second.train||!p.transfer||first.train.runId===second.train.runId
  ||first.from.code!==p.origin.code||second.to.code!==p.target.code||first.to.code!==second.from.code
  ||p.transfer.station.code!==first.to.code||first.departureIso!==p.departureIso||second.arrivalIso!==p.arrivalIso
  ||first.train.runId!==p.train.runId||first.train.trainNo!==p.train.trainNo
  ||p.uncovered!==null||!Number.isFinite(wait)||wait<p.transfer.minMinutes||wait>960
  ||Math.abs(wait-p.transfer.waitMinutes)>0.001||total<=0||total>2880
  ||p.transfer.overnight!==(date(first.arrivalIso)!==date(second.departureIso))
  ||p.legs.some(l=>Date.parse(l.arrivalIso)<=Date.parse(l.departureIso)||l.train!.serviceDate>date(l.departureIso)))
   c.addIssue({code:z.ZodIssueCode.custom,message:'异车中转的车次身份、接续车站或时间无效'});
 const prices=p.legs.map(l=>l.inventory.price);
 const sum=prices.every(v=>v!==null)?Math.round(prices.reduce((n,v)=>n+v!,0)*100)/100:null;
 if(p.totalPrice!==sum)c.addIssue({code:z.ZodIssueCode.custom,message:'中转合计与两张票的官方票价不一致'});
};
export const planSchema=planBase.superRefine(sellable);
export const resultSchema=z.object({plans:z.array(planSchema).max(3000),observations:z.array(quote).max(10000),complete:z.boolean(),issues:z.array(z.string().max(1000)).max(500),completedAt:iso.nullable(),suggestedDestinations:z.array(station).max(10).optional(),stationAlternatives:z.array(z.object({requestedFrom:station,requestedTo:station,from:station,to:station,date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),fetchedAt:iso})).max(80).optional(),transferSearch:z.object({stations:z.array(station).max(32),checked:z.number().int().nonnegative(),scope:z.literal('limited')}).optional()});
const packedResultSchema=resultSchema.omit({plans:true}).extend({format:z.literal('rail-result-v1'),routes:z.array(z.array(stop).max(200)).max(3000),plans:z.array(planBase.omit({route:true}).extend({routeIndex:z.number().int().nonnegative()}).superRefine(sellable)).max(3000)}).superRefine((r,c)=>{if(r.plans.some(p=>p.routeIndex>=r.routes.length))c.addIssue({code:z.ZodIssueCode.custom,message:'路线快照引用无效'});});
export const inputSchema=z.object({origin:station,destinations:z.array(station).min(1).max(8),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),earliestTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),trainTypes:z.array(z.enum(['G','D','C'])).min(1).max(3),seats:z.array(seat).min(1).max(4),includeLongTicket:z.boolean(),includeExtension:z.boolean(),passengerCount:z.number().int().min(1).max(5).optional(),sameSeatOnly:z.boolean().optional(),includeTransfer:z.boolean().optional(),transferStations:z.array(station).max(3).optional(),minTransferMinutes:z.number().int().min(20).max(180).optional(),allowOvernightTransfer:z.boolean().optional()}).superRefine((v,c)=>{
 if(new Set(v.destinations.map(s=>s.code)).size!==v.destinations.length||v.destinations.some(s=>s.code===v.origin.code))c.addIssue({code:z.ZodIssueCode.custom,message:'到站不能重复或与出发站相同'});
 if(v.transferStations&&(new Set(v.transferStations.map(s=>s.code)).size!==v.transferStations.length||v.transferStations.some(s=>s.code===v.origin.code||v.destinations.some(d=>d.code===s.code))))c.addIssue({code:z.ZodIssueCode.custom,message:'中转站不能重复或与起终点相同'});
 const d=new Date(v.date+'T00:00:00+08:00');
 if(!Number.isFinite(d.getTime())||d.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})!==v.date)c.addIssue({code:z.ZodIssueCode.custom,message:'日期无效'});
 const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
 if(v.date<today)c.addIssue({code:z.ZodIssueCode.custom,message:'请选择今天或之后的日期'});
});
export const helperUpdateSchema=z.object({leaseToken:z.string().min(20).max(150),version:z.number().int().positive(),status:z.enum(['running','waiting_user','partial','complete','unavailable']),message:z.string().max(1000),result:z.union([packedResultSchema,resultSchema]).transform(unpackResult).optional()});
