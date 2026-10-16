import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyPrices,inventory,parseStops,parseTickets,SourceError,StationMismatchError,chinaDate,ticketPrices} from '../src/parsers.ts';
const from={name:'甲站',code:'AAA'},middle={name:'乙站',code:'BBB'},to={name:'丙站',code:'CCC'};
function row(overrides:Record<number,string>={}){const p=Array(60).fill('');Object.assign(p,{1:'预订',2:'550000G12340',3:'G1234',4:'AAA',5:'CCC',6:'AAA',7:'CCC',8:'23:30',9:'01:15',10:'01:45',11:'Y',13:'20261005',16:'01',17:'03',26:'无',30:'2',31:'有',32:'--'},overrides);return {status:true,data:{result:[p.join('|')],map:{AAA:'甲站',CCC:'丙站'}}};}
test('库存明确区分数值、有、无、候补、未开售、不支持、未知',()=>{
  assert.deepEqual(inventory('2',true,'预订'),{status:'available',count:2,price:null});
  assert.equal(inventory('0',true,'预订').status,'sold_out');
  assert.equal(inventory('有',true,'预订').status,'available');
  assert.equal(inventory('候补',true,'预订').status,'waitlist');
  assert.equal(inventory('--',true,'预订').status,'unsupported');
  assert.equal(inventory('暂停',true,'预订').status,'unknown');
  assert.equal(inventory('无',false,'明日 8:00 起售').status,'not_on_sale');
});
test('跨午夜依实际历时确定到达日，运行身份含始发日',()=>{
  const [q]=parseTickets(row(),from,to,'2026-10-05');
  assert.equal(q.arrivalIso.slice(0,16),'2026-10-06T01:15');assert.equal(q.train.serviceDate,'2026-10-05');
  assert.equal(q.train.runId,'2026-10-05:550000G12340');
  assert.equal(q.seats.second.count,2);assert.equal(q.seats.business.status,'unsupported');
});
test('官网候补标记只改变无票座席，无座不推断为候补',()=>{
  const [q]=parseTickets(row({0:'synthetic-reservation-secret',30:'无',31:'无',37:'1'}),from,to,'2026-10-05');
  assert.equal(q.seats.second.status,'waitlist');assert.equal(q.seats.first.status,'waitlist');assert.equal(q.seats.standing.status,'sold_out');
  assert.equal(JSON.stringify(q).includes('synthetic-reservation-secret'),false);
});
test('同城其他站候选排除，官方非可售时段标记不能变成可买',()=>{
  const own=row({11:'IS_TIME_NOT_BUY'}),foreign=row({6:'DDD',13:''});
  const data={status:true,data:{result:[...foreign.data.result,...own.data.result],map:{AAA:'甲站',CCC:'丙站',DDD:'同城其他站'}}};
  const rows=parseTickets(data,from,to,'2026-10-05');assert.equal(rows.length,1);assert.equal(rows[0].canBuy,false);assert.equal(rows[0].from.code,'AAA');
});
test('不能把 HTTP 层或 HTML/错误业务结构当作空票源',()=>{
  assert.throws(()=>parseTickets('<html>网络错误</html>',from,to,'2026-10-05'),SourceError);
  assert.throws(()=>parseTickets({status:false,data:{result:[],map:{}}},from,to,'2026-10-05'),SourceError);
  assert.throws(()=>parseTickets(row({9:'03:15'}),from,to,'2026-10-05'),SourceError);
  assert.throws(()=>parseTickets(row({13:'20261006'}),from,to,'2026-10-05'),SourceError);
  assert.throws(()=>chinaDate('2026-02-30'),SourceError);
});
test('仅其他车站时保留真实组合，仍保持所选区间未知且不迁移库存',()=>{
  const foreign=row({6:'DDD'});foreign.data.map={...foreign.data.map,...{DDD:'同城另一站'}};
  assert.throws(()=>parseTickets(foreign,from,to,'2026-10-05','2026-10-05T15:00:00Z'),error=>{
    assert.ok(error instanceof StationMismatchError);
    assert.deepEqual(error.stationAlternatives,[{requestedFrom:from,requestedTo:to,from:{name:'同城另一站',code:'DDD'},to,date:'2026-10-05',fetchedAt:'2026-10-05T15:00:00Z'}]);
    assert.ok(!JSON.stringify(error.stationAlternatives).includes('seats'));return true;
  });
  assert.deepEqual(parseTickets({status:true,data:{result:[],map:{}}},from,to,'2026-10-05'),[]);
  const malformed=row({6:'DDD',13:''});malformed.data.map={...malformed.data.map,...{DDD:'同城另一站'}};
  assert.throws(()=>parseTickets(malformed,from,to,'2026-10-05'),error=>error instanceof SourceError&&!(error instanceof StationMismatchError));
});
test('完整停站表与余票区间日期和站序一致才可认定同车',()=>{
  const [q]=parseTickets(row(),from,to,'2026-10-05');
  const payload={status:true,data:{data:[{station_no:'01',station_name:'甲站',arrive_time:'----',start_time:'23:30'},{station_no:'02',station_name:'乙站',arrive_time:'00:10',start_time:'00:12'},{station_no:'03',station_name:'丙站',arrive_time:'01:15',start_time:'----'}]}};
  const stops=parseStops(payload,q,[from,middle,to]);assert.equal(stops[1].departureIso?.slice(0,16),'2026-10-06T00:12');
  assert.throws(()=>parseStops(payload,{...q,toIndex:2},[from,middle,to]),SourceError);
});
test('缺失或非法票价保持 null，确认价只应用对应席别',()=>{
  const [q]=parseTickets(row(),from,to,'2026-10-05');
  applyPrices({status:true,data:{O:'¥120.50',M:'unknown',A9:'￥600',WZ:null}},q);
  assert.equal(q.seats.second.price,120.5);assert.equal(q.seats.first.price,null);assert.equal(q.seats.business.price,600);assert.equal(q.seats.standing.price,null);
});
test('初查响应的实际票价区分座席和无座，非法或冲突字段保持未知',()=>{
  const fares='9039500009M019650021O012350001O012353118';
  assert.deepEqual(ticketPrices(fares),{business:395,first:196.5,second:123.5,standing:123.5});
  const [q]=parseTickets(row({39:fares}),from,to,'2026-10-05');
  assert.equal(q.seats.second.price,123.5);assert.equal(q.seats.standing.price,123.5);
  assert.deepEqual(ticketPrices('O012350001O013000002'),{});
  assert.deepEqual(ticketPrices('O012350001broken'),{});
  assert.deepEqual(ticketPrices(undefined),{});
  assert.deepEqual(ticketPrices('P039500009'),{});
});
