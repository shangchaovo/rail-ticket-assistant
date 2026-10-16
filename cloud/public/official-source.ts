import type {Adapter,SegmentQuote,Station,TrainStop} from '../../lib/rail-types.ts';
import {parseStops,parseTickets,SourceError} from '../../helper/src/parsers.ts';
import {leftTicketUrl,officialAccess,officialTicketPath,rotatedTicketPath,trainStopUrl} from '../../helper/src/official-api.ts';
import {transferCandidates} from '../../helper/src/transfer-stations.ts';
import catalog from '../../lib/stations.json' with {type:'json'};
const ORIGIN='https://kyfw.12306.cn',ENTRY=ORIGIN+'/otn/leftTicket/init';
const stations:Station[]=catalog.map(s=>({name:s.name,code:s.code}));
const stationKeys=new Set(stations.map(s=>s.code+':'+s.name));
export function verifiedStation(station:Station){return stationKeys.has(station.code+':'+station.name);}
function stop(code:'rate'|'verify'|'budget'):never {
 const message=code==='rate'?'12306 暂时限制查询，本轮已停止，请稍后再查。':code==='verify'?'12306 要求人工验证，本轮已停止。请稍后再试，或直接打开官网查询。':'本轮查询预算已用完，其余区间尚未核验。';
 throw Object.assign(new SourceError(message),{code});
}
export class PublicOfficialSource implements Adapter {
 private cookies=new Map<string,string>();private path='';private requests=0;private last=0;private blocked=false;
 private options:{signal?:AbortSignal;fetcher?:typeof fetch;maxRequests?:number;gapMs?:number};
 constructor(options:{signal?:AbortSignal;fetcher?:typeof fetch;maxRequests?:number;gapMs?:number}={}){this.options=options;}
 private async get(url:string,accept:string){
  if(this.blocked)throw new SourceError('本轮已停止后续官网请求');
  if(this.options.signal?.aborted)throw new SourceError('查询已取消或超时');
  if(++this.requests>(this.options.maxRequests??16))stop('budget');
  const gap=Math.max(0,(this.options.gapMs??450)-(Date.now()-this.last));
  if(gap)await new Promise(resolve=>setTimeout(resolve,gap));
  if(this.options.signal?.aborted)throw new SourceError('查询已取消或超时');this.last=Date.now();
  const headers:Record<string,string>={Accept:accept,Referer:ENTRY};
  if(this.cookies.size)headers.Cookie=[...this.cookies].map(([k,v])=>k+'='+v).join('; ');
  let response:Response,text:string;
  try{response=await(this.options.fetcher??fetch)(url,{headers,redirect:'manual',signal:this.options.signal?AbortSignal.any([this.options.signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});text=await response.text();}
  catch{throw new SourceError('官网本次响应未取得，无法确认余票，请稍后再试。');}
  if(response.status===429){this.blocked=true;stop('rate');}
  if([401,403].includes(response.status)){this.blocked=true;stop('verify');}
  if(response.status!==200)throw new SourceError(`官网暂时不可用（HTTP ${response.status}），当前库存未知。`);
  for(const cookie of(response.headers.get('set-cookie')||'').split(/,(?=\s*[^;,\s]+=)/)){
   const pair=cookie.split(';')[0],i=pair.indexOf('=');if(i>0)this.cookies.set(pair.slice(0,i).trim(),pair.slice(i+1));
  }
  return text;
 }
 private async ready(){
  if(this.path)return;
  const html=await this.get(ENTRY,'text/html,application/xhtml+xml');
  this.path=officialTicketPath(html.match(/(?:var\s+)?CLeftTicketUrl\s*=\s*['"]([^'"\r\n]+)['"]/)?.[1]||'')||'';
  if(!this.path)throw new SourceError('官网查询入口已变化，本次无法取得实时库存。');
 }
 private async json(url:string):Promise<unknown>{
  const text=await this.get(url,'application/json, text/javascript, */*; q=0.01');
  let payload:unknown=null;try{payload=JSON.parse(text);}catch{/* Validated below. */}
  const access=officialAccess(200,payload,text);
  if(access==='verify'||access==='rate'){this.blocked=true;stop(access);}
  if(access!=='ok'&&access!=='rotate')throw new SourceError('官方响应未通过校验，当前余票未知。');
  return payload;
 }
 async query(from:Station,to:Station,date:string):Promise<SegmentQuote[]>{
  if(!verifiedStation(from)||!verifiedStation(to))throw new SourceError('请选择官方实际车站。');
  await this.ready();let payload=await this.json(leftTicketUrl(this.path,from,to,date));
  const rotated=rotatedTicketPath(payload);if(rotated&&rotated!==this.path){this.path=rotated;payload=await this.json(leftTicketUrl(this.path,from,to,date));}
  return parseTickets(payload,from,to,date);
 }
 async stops(quote:SegmentQuote):Promise<TrainStop[]>{await this.ready();return parseStops(await this.json(trainStopUrl(quote)),quote,stations);}
 async transferStations(from:Station,to:Station){return transferCandidates(from,to,stations).stations.slice(0,2);}
}
