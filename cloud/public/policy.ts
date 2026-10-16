import {inputSchema} from '../../lib/rail-validation.ts';
import {verifiedStation} from './official-source.ts';
import type {RailSearch,SearchResult} from '../../lib/rail-types.ts';
export const PUBLIC_LIMITS={requests:12,expandedRuns:2,splitStops:1,longStops:1,plans:240,observations:400,resultBytes:600_000} as const;
export const PUBLIC_DAILY_LIMIT=100,IP_DAILY_LIMIT=20,CONCURRENT_LIMIT=2;
export class PublicError extends Error{
 status:number;retryAfter:number;
 constructor(status:number,message:string,retryAfter=0){super(message);this.status=status;this.retryAfter=retryAfter;}
}
export function publicInput(value:unknown,now=Date.now()):RailSearch{
 const parsed=inputSchema.safeParse(value);if(!parsed.success)throw new PublicError(400,parsed.error.issues[0]?.message||'查询条件无效。');
 const input=parsed.data;
 if(input.destinations.length!==1||(input.transferStations?.length??0)>2)throw new PublicError(400,'公开版每次查询一个到站，最多指定两个中转站。');
 if([input.origin,...input.destinations,...(input.transferStations||[])].some(s=>!verifiedStation(s)))throw new PublicError(400,'请从建议列表选择实际车站。');
 const today=new Date(now+8*3600_000).toISOString().slice(0,10),last=new Date(Date.parse(today+'T00:00:00+08:00')+14*86400000+8*3600_000).toISOString().slice(0,10);
 if(input.date<today||input.date>last)throw new PublicError(400,'公开版支持今天起 15 天内的查询。');
 return input;
}
/** Result payloads contain current normalized quotes; never an owner session, browser cookie or booking token. */
export function publicResult(result:SearchResult):SearchResult{return {...result,issues:result.issues.map(v=>v.replaceAll('请在电脑的官方浏览器处理后重新查询','请稍后再试或直接在官网查询').replaceAll('请在电脑','请在本人设备'))};}
export const dailyWindow=(now=Date.now())=>new Date(now+8*3600_000).toISOString().slice(0,10);
