import type {Inventory, SeatType, SegmentQuote, Station, StationAlternative, TrainStop} from '../shared/rail-types.ts';

export class SourceError extends Error { constructor(message:string) {super(message); this.name='SourceError';} }
export class StationMismatchError extends SourceError {
  stationAlternatives:StationAlternative[];
  constructor(stationAlternatives:StationAlternative[]) {
    super('12306 本次仅返回同城其他车站的班次，所选车站区间尚未确认。请选择实际出发站和到站重新查询');
    this.stationAlternatives=stationAlternatives;
  }
}
const seatIndex:Record<SeatType,number>={business:32,first:31,second:30,standing:26};
const seatPriceKey:Record<SeatType,string>={business:'A9',first:'M',second:'O',standing:'WZ'};
const plainObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
// Official queryLeftTicket_end_js maps query field 39 to yp_info_new and
// renders ten-character records: seat code, five-digit fare in tenths of yuan,
// inventory kind (3 = standing), then three-digit remaining inventory.
// This is a price snapshot from the normal query response, never an estimate.
export function ticketPrices(value:unknown):Partial<Record<SeatType,number>> {
  if(typeof value!=='string'||!value||value.length%10!==0||!/^(?:[A-Z0-9]\d{9})+$/.test(value))return {};
  const values=new Map<SeatType,Set<number>>();
  for(let i=0;i<value.length;i+=10){
    const record=value.slice(i,i+10),code=record[0];
    const seat:SeatType|undefined=record[6]==='3'?'standing':code==='9'?'business':code==='M'?'first':code==='O'?'second':undefined;
    const fare=Number(record.slice(1,6))/10;
    if(!seat||fare<=0)continue;
    const fares=values.get(seat)??new Set<number>();fares.add(fare);values.set(seat,fares);
  }
  return Object.fromEntries([...values].filter(([,fares])=>fares.size===1).map(([seat,fares])=>[seat,[...fares][0]]));
}
export function chinaDate(value:string):string {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SourceError('乘车日期格式无效');
  const d=new Date(`${value}T00:00:00+08:00`);
  if(!Number.isFinite(d.getTime())||chinaIso(d.getTime()).slice(0,10)!==value) throw new SourceError('乘车日期无效');
  return value;
}
export function chinaIso(epoch:number):string {return new Date(epoch+8*3600_000).toISOString().replace(/Z$/,'+08:00');}
function time(v:unknown):string {if(typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))throw new SourceError('官方时刻字段无法识别');return v;}
function integer(v:string):number {if(!/^\d{1,3}$/.test(v))throw new SourceError('官方站序字段无法识别');return Number(v);}
export function inventory(value:string,canBuy:boolean,saleMessage:string):Inventory {
  if(/起售|暂停售票|停止售票|未开售|售票时间/.test(saleMessage)&&!canBuy) return {status:'not_on_sale',price:null};
  if(value==='有') return {status:'available',price:null};
  if(/^\d+$/.test(value)) {const count=Number(value);if(!Number.isSafeInteger(count))return {status:'unknown',price:null};return {status:count>0?'available':'sold_out',count,price:null};}
  if(value==='无')return {status:'sold_out',price:null};
  if(value==='候补')return {status:'waitlist',price:null};
  if(value===''||value==='--')return {status:'unsupported',price:null};
  return {status:'unknown',price:null};
}
export function parseTickets(payload:unknown,from:Station,to:Station,date:string,fetchedAt=new Date().toISOString()):SegmentQuote[] {
  chinaDate(date);
  if(!plainObject(payload)||payload.status!==true||!plainObject(payload.data)||!Array.isArray(payload.data.result)||!plainObject(payload.data.map))throw new SourceError('官方返回未通过业务校验，不能判断余票');
  const map=payload.data.map;
  const parsed=payload.data.result.map((raw:unknown):SegmentQuote|null=>{
    if(typeof raw!=='string')throw new SourceError('官方余票结构已变化');
    const p=raw.split('|');
    if(p.length<18)throw new SourceError('官方余票区间字段不完整');
    // Excluded same-city alternatives are not inputs to this selected-station route.
    if(p[6]!==from.code||p[7]!==to.code)return null;
    if(p.length<36||!p[2]||!/^[A-Za-z0-9 ]{4,40}$/.test(p[2])||!/^\d{8}$/.test(p[13])||!['Y','N','IS_TIME_NOT_BUY'].includes(p[11]))throw new SourceError('官方列车身份字段不完整');
    if(!/^\w{3}$/.test(p[6])||!/^\w{3}$/.test(p[7])||typeof map[p[6]]!=='string'||typeof map[p[7]]!=='string')throw new SourceError('官方站点字段不完整');
    const serviceDate=chinaDate(`${p[13].slice(0,4)}-${p[13].slice(4,6)}-${p[13].slice(6,8)}`);
    if(serviceDate>date)throw new SourceError('始发运行日晚于上车日期');
    const fromIndex=integer(p[16]),toIndex=integer(p[17]);
    if(fromIndex<1||toIndex<=fromIndex)throw new SourceError('官方站序顺序无效');
    const departureIso=`${date}T${time(p[8])}:00+08:00`;
    if(!/^\d{1,3}:[0-5]\d$/.test(p[10]))throw new SourceError('官方历时字段无法识别');
    const [hours,minutes]=p[10].split(':').map(Number);
    const arrivalIso=chinaIso(Date.parse(departureIso)+(hours*60+minutes)*60_000);
    if(arrivalIso.slice(11,16)!==time(p[9]))throw new SourceError('发到时刻与历时不一致，无法确认跨日日期');
    const canBuy=p[11]==='Y';
    const seats=Object.fromEntries(Object.entries(seatIndex).map(([seat,i])=>[seat,inventory(p[i]??'',canBuy,p[1])])) as Record<SeatType,Inventory>;
    for(const [seat,price] of Object.entries(ticketPrices(p[39])))seats[seat as SeatType].price=price;
    // The official frontend renders sold-out seated inventory as 候补 for flagged trains.
    // Standing inventory is explicitly excluded by the official frontend.
    if(p[37]==='1'&&p[0]&&p[0]!=='null')for(const seat of ['business','first','second'] as const){if(seats[seat].status==='sold_out'&&p[seatIndex[seat]]==='无')seats[seat].status='waitlist';}
    return {train:{trainNo:p[2].trim(),serviceDate,trainCode:p[3],runId:`${serviceDate}:${p[2].trim()}`},from:{name:String(map[p[6]]),code:p[6]},to:{name:String(map[p[7]]),code:p[7]},fromIndex,toIndex,departureIso,arrivalIso,canBuy,seats,fetchedAt,source:'12306'};
  });
  const matched=parsed.filter((q):q is SegmentQuote=>q!==null);
  if(!matched.length&&payload.data.result.length){
    const alternatives:StationAlternative[]=[];
    const seen=new Set<string>();
    for(const raw of payload.data.result){
      const p=raw.split('|'),key=`${p[6]}:${p[7]}`;
      if(!/^[A-Z]{3}$/.test(p[6])||!/^\w{3}$/.test(p[7])||typeof map[p[6]]!=='string'||typeof map[p[7]]!=='string')throw new SourceError('官方站点字段不完整');
      // Re-parse every foreign row against its own endpoints before offering
      // a station pair. No foreign inventory becomes a selected-route quote.
      const a={name:String(map[p[6]]),code:p[6]},b={name:String(map[p[7]]),code:p[7]};
      parseTickets({status:true,data:{result:[raw],map}},a,b,date,fetchedAt);
      if(!seen.has(key)&&alternatives.length<8){seen.add(key);alternatives.push({requestedFrom:from,requestedTo:to,from:a,to:b,date,fetchedAt});}
    }
    throw new StationMismatchError(alternatives);
  }
  return matched;
}
export function parseStations(script:string):Station[] {
  const match=script.match(/var\s+station_names\s*=\s*['"]([^'"\r\n]+)['"]\s*;/);
  if(!match)throw new SourceError('官方站名文件无法识别');
  const stations=match[1].split('@').filter(Boolean).map(r=>r.split('|')).filter(p=>p[1]&&/^[A-Z0-9]{3}$/.test(p[2])).map(p=>({name:p[1],code:p[2]}));
  if(stations.length<100)throw new SourceError('官方站名文件不完整');
  return stations;
}
export function parseStops(payload:unknown,quote:SegmentQuote,stations:Station[]):TrainStop[] {
  if(!plainObject(payload)||payload.status!==true||!plainObject(payload.data)||!Array.isArray(payload.data.data)||payload.data.data.length<2)throw new SourceError('官方经停数据未通过业务校验');
  const byName=new Map(stations.map(s=>[s.name,s]));
  const rows=payload.data.data;
  let previousEpoch=Date.parse(`${quote.train.serviceDate}T00:00:00+08:00`),previousIndex=0;
  const result=rows.map((r:unknown,index:number)=>{
    if(!plainObject(r)||typeof r.station_name!=='string'||typeof r.station_no!=='string')throw new SourceError('官方经停字段无法识别');
    const station=byName.get(r.station_name);if(!station)throw new SourceError('经停车站未在官方站名表中找到');
    const stopIndex=integer(r.station_no);if(stopIndex<=previousIndex)throw new SourceError('经停站序未按顺序排列');previousIndex=stopIndex;
    const dateTime=(v:unknown,endpoint:boolean):string|null=>{
      if(v==='----'||v==='--:--'||v==='-----'||v===''||v===null||v===undefined){if(endpoint)return null;throw new SourceError('中途站时刻缺失');}
      const clock=time(v);let epoch=Date.parse(`${chinaIso(previousEpoch).slice(0,10)}T${clock}:00+08:00`);
      if(epoch<previousEpoch)epoch+=24*3600_000;
      previousEpoch=epoch;return chinaIso(epoch);
    };
    const arrivalIso=dateTime(r.arrive_time,index===0),departureIso=dateTime(r.start_time,index===rows.length-1);
    return {station,index:stopIndex,arrivalIso,departureIso};
  });
  const origin=result.find(s=>s.index===quote.fromIndex&&s.station.code===quote.from.code),target=result.find(s=>s.index===quote.toIndex&&s.station.code===quote.to.code);
  if(origin?.departureIso!==chinaIso(Date.parse(quote.departureIso))||target?.arrivalIso!==chinaIso(Date.parse(quote.arrivalIso)))throw new SourceError('经停日期与余票区间不一致，不能确认同一运行列车');
  return result;
}
export function applyPrices(payload:unknown,quote:SegmentQuote):void {
  if(!plainObject(payload)||payload.status!==true||!plainObject(payload.data))return;
  for(const [seat,key] of Object.entries(seatPriceKey)){
    const v=payload.data[key];if(typeof v!=='string'&&typeof v!=='number')continue;
    const s=String(v).replace(/^[¥￥]/,'').trim();if(!/^\d+(\.\d{1,2})?$/.test(s))continue;
    const price=Number(s);if(Number.isFinite(price)&&price>0)quote.seats[seat as SeatType].price=price;
  }
}
