import {recommendPlans,recommendationLabels,previewRecommendations,type RecommendationMode} from '../../lib/rail-recommendation.ts';
import {purchaseLinks} from '../../lib/rail-purchase.ts';
import {currentPlan} from '../../lib/rail-freshness.ts';
import type {RailSearch,SearchResult,Station,TicketPlan,SeatType,JobStatus} from '../../lib/rail-types.ts';
import {initAssistant} from './assistant-client.ts';
import type {FormDraft} from './assistant-types.ts';
import {apiFetch} from './transport.ts';
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const field=(id:string)=>$<HTMLInputElement>(id);
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const SEATS:Record<string,string>={second:'二等座',first:'一等座',business:'商务座',standing:'无座'};
const KINDS:Record<string,string>={direct:'直达票',split:'同车两段票',transfer:'异车中转',long:'买长乘短',extension:'短票＋申请补票'};
let result:SearchResult|null=null,input:RailSearch|null=null,sort:RecommendationMode='balanced',kind='all',showAll=false,busy=false,abort:AbortController|undefined,queryState:JobStatus='complete';
let evidenceToken:string|undefined;
const selected=(id:string)=>[...$(id).querySelectorAll<HTMLInputElement>('input:checked')].map(i=>i.value);
const day=(time:number)=>new Date(time+8*3600000).toISOString().slice(0,10);
const time=(iso:string)=>new Date(Date.parse(iso)+8*3600000).toISOString().slice(11,16);
const date=(iso:string)=>new Date(Date.parse(iso)+8*3600000).toISOString().slice(0,10);
const stamp=(iso:string)=>`${date(iso).slice(5)} ${time(iso)}`;
const money=(value:number|null)=>value===null?'待确认':`¥${value}`;
const duration=(a:string,b:string)=>{const n=Math.round((Date.parse(b)-Date.parse(a))/60000);return `${Math.floor(n/60)}小时${n%60?`${n%60}分`:''}`;};
field('date').value=day(Date.now());field('date').min=day(Date.now());field('date').max=day(Date.now()+14*86400000);
field('time').value=time(new Date().toISOString());
const stationChoices=new Map<string,Station>();
async function stationList(query:string){const r=await apiFetch('/api/public/stations?q='+encodeURIComponent(query));if(!r.ok)throw Error('车站目录暂不可用，请稍后再试。');const data=await r.json() as {stations:Station[]};for(const s of data.stations)stationChoices.set(s.name,s);return data.stations;}
for(const id of ['from','to','middle']){
 let timer:ReturnType<typeof setTimeout>|undefined,version=0;
 field(id).addEventListener('input',()=>{clearTimeout(timer);const v=++version,q=field(id).value.trim();timer=setTimeout(()=>{void stationList(q).then(rows=>{if(v===version)$(id+'-options').replaceChildren(...rows.map(s=>{const option=document.createElement('option');option.value=s.name;option.label=s.name;return option;}));}).catch(()=>{});},250);});
 field(id).addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
}
async function station(id:string):Promise<Station>{const name=field(id).value.trim();const known=stationChoices.get(name);if(known)return known;const found=(await stationList(name)).find(s=>s.name===name);if(!found)throw Error('请填写完整的实际车站名，并从建议中选择。');return found;}
function error(message:string){$('form-error').textContent=message;$('form-error').hidden=!message;}
function status(message:string,warning=false){$('progress').textContent=message;$('progress').hidden=false;$('progress').classList.toggle('error',warning);}
function setBusy(value:boolean,owner:'query'|'assistant'='query'){busy=value;for(const element of $('query-form').querySelectorAll<HTMLElement & {disabled:boolean}>('input,select,#swap'))element.disabled=value;$<HTMLButtonElement>('search').disabled=value;$<HTMLButtonElement>('cancel').hidden=!value||owner==='assistant';for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-recheck]'))button.disabled=value;assistantUi?.setExternalBusy(value&&owner==='query');}
function planCard(plan:TicketPlan,labels:Record<string,string[]>){
 const trains=plan.kind==='transfer'?plan.legs.map(l=>l.train?.trainCode).join(' → '):plan.train.trainCode;
 const stock=plan.legs.map(l=>`${SEATS[l.seat]} ${l.inventory.count===undefined?'有票':l.inventory.count+' 张'}`).join(' / ');
 const connection=plan.kind==='transfer'?`${plan.transfer?.station.name}换车 · 等待 ${plan.transfer?.waitMinutes} 分钟`:plan.kind==='split'?`${plan.legs[0].to.name}接续 · 可能换座`:'同一趟列车';
 const overnight=plan.transfer?.overnight?'次日换乘，需自行安排过夜；住宿不计入票价。':'';
 const links=purchaseLinks(plan).map(l=>`<a class="buy" target="_blank" rel="noopener noreferrer" href="${esc(l.url)}">${esc(l.label)} ↗</a>`).join('');
 return `<article class="plan" data-plan-id="${esc(plan.id)}"><div class="plan-head"><strong class="train">${esc(trains)}</strong><span class="tag kind">${esc(KINDS[plan.kind])}</span>${(labels[plan.id]||[]).slice(0,2).map(l=>`<span class="tag">${esc(l)}</span>`).join('')}</div><div class="plan-main"><div class="route">${esc(plan.origin.name)} → ${esc(plan.target.name)}<span class="stock">${esc(stock)}</span></div><div class="times"><strong>${time(plan.departureIso)} → ${time(plan.arrivalIso)}</strong><span>${date(plan.departureIso)} 出发${date(plan.departureIso)!==date(plan.arrivalIso)?' · '+date(plan.arrivalIso)+' 到达':''}</span></div><div class="duration">${duration(plan.departureIso,plan.arrivalIso)}<small>${esc(connection)}</small></div><div class="total">${money(plan.totalPrice??(plan.kind==='extension'?plan.legs[0].inventory.price:null))}<small>${plan.kind==='extension'?'每人短票 · 补票金额待确认':'每人票面合计'}</small></div></div><div class="plan-actions"><button type="button" data-recheck="${esc(plan.id)}"${busy?' disabled':''}>重新核验</button>${links}<small>采集 ${stamp(plan.fetchedTo)} · 尚未购买</small></div>${overnight?`<p class="risk">${overnight}</p>`:''}${plan.uncovered?`<p class="risk">${esc(plan.uncovered.from.name)} → ${esc(plan.uncovered.to.name)} 尚未覆盖，申请补票可能被拒绝。</p>`:''}<details class="ticket-details"><summary>查看 ${plan.legs.length} 张票与乘车说明</summary>${plan.legs.map((l,i)=>`<div class="ticket"><strong>第 ${i+1} 张 · ${esc(l.train?.trainCode||plan.train.trainCode)}</strong><span>${esc(l.from.name)} → ${esc(l.to.name)}</span><small>${esc(stamp(l.departureIso))} → ${esc(stamp(l.arrivalIso))} · ${esc(SEATS[l.seat])} · ${money(l.inventory.price)}</small></div>`).join('')}<p>${esc(plan.warning||'官网入口带入实际车站与日期，进入后请选择对应车次和席别。查询不会保留余票。')}${plan.kind==='transfer'?' 两张票分别购买，晚点可能错过下一趟。':''}</p></details></article>`;
}
function render(){
 if(!result)return;
 const plans=result.plans.filter(p=>currentPlan(p,queryState,Date.now()));
 const filtered=plans.filter(p=>kind==='all'?p.kind!=='extension':p.kind===kind);
 const ordered=recommendPlans(filtered,sort),shown=showAll?ordered:sort==='balanced'?previewRecommendations(ordered):ordered.slice(0,6),labels=recommendationLabels(plans);
 $('tools').hidden=false;$('summary').textContent=`${plans.length} 个当前方案${busy?' · 核验中':''}`;
 $('result-meta').innerHTML=`<p class="meta">${input?esc(input.origin.name)+' → '+esc(input.destinations[0].name)+' · '+esc(input.date)+' · ':''}推荐限于本次已核验候选，用时包含等车。${result.completedAt?'采集 '+esc(stamp(result.completedAt)):''}</p>`;
 $('plans').innerHTML=shown.length?shown.map(p=>planCard(p,labels)).join(''):`<div class="empty"><h3>${busy?'仍在核验，请稍候':result.plans.length&&!plans.length?'库存已超过时效，请重新查询':'本次没有符合条件的可买方案'}</h3><p>${kind!=='all'&&plans.length?'可切换其他方案类型。':result.plans.length&&!plans.length?'旧库存不能用来判断现在是否有票。':'可调整日期、席别或中转站；未找到方案不代表两站无法到达。'}</p></div>`;
 $('more').hidden=showAll||ordered.length<=shown.length;$('more').textContent=`查看其余 ${ordered.length-shown.length} 个方案`;
 const notes=[...result.issues,...(result.transferSearch?[`本次中转候选：${result.transferSearch.stations.map(s=>s.name).join('、')||'尚未取得'}；核验 ${result.transferSearch.checked} 个候选区间，支持一次同站换车。`]:[])];
 $('issues').hidden=!notes.length;$('issues').querySelector('div')!.innerHTML=notes.map(v=>`<p>${esc(v)}</p>`).join('');
 const direct=result.observations.filter(q=>q.from.code===input?.origin.code&&q.to.code===input?.destinations[0].code&&Date.parse(q.departureIso)>=Date.parse(input!.date+'T'+input!.earliestTime+':00+08:00'));
 const waitlist=direct.filter(q=>input!.seats.some(s=>q.seats[s].status==='waitlist')&&!plans.some(p=>p.train.runId===q.train.runId&&p.kind==='direct'));
 const notOnSale=direct.filter(q=>input!.seats.some(s=>q.seats[s].status==='not_on_sale'));
 $('other-status').innerHTML=[['仅候补的直达车次',waitlist],['尚未起售的直达车次',notOnSale]].filter(([,rows])=>(rows as typeof direct).length).map(([title,rows])=>`<div class="other"><h3>${title}</h3>${(rows as typeof direct).slice(0,12).map(q=>`<span>${esc(q.train.trainCode)} ${time(q.departureIso)}　</span>`).join('')}</div>`).join('');
}
async function run(mode:'search'|'recheck',search:RailSearch,plan?:TicketPlan){
 if(!busy){evidenceToken=undefined;assistantUi?.resetContext();}
 if(busy)return;queryState='running';error('');result=null;input=search;showAll=false;setBusy(true);$('tools').hidden=true;$('result-meta').textContent='';$('other-status').textContent='';$('issues').hidden=true;$('more').hidden=true;$('plans').innerHTML='';status(mode==='recheck'?'正在重新核验每张票的新库存…':'正在查询实时余票…');abort=new AbortController();
 try{
  const response=await apiFetch('/api/public/query',{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({mode,input:search,...(plan?{plan}:{})}),signal:abort.signal});
  if(!response.ok){const data=await response.json().catch(()=>({})) as {error?:string};throw Error(data.error||'查询暂时不可用，请稍后再试。');}
  if(!response.body)throw Error('未收到查询结果，请稍后再试。');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',final=false;
  for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let end;
   while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=event.split('\n').find(v=>v.startsWith('data: '));if(!line)continue;const data=JSON.parse(line.slice(6)) as {message?:string;result?:SearchResult;remaining?:number};
    if('evidenceToken' in data&&typeof data.evidenceToken==='string')evidenceToken=data.evidenceToken;
    if(data.result){result=data.result;render();}
    if(event.startsWith('event: result')){final=true;queryState=result?.complete?'complete':'partial';status(result?.complete?'本轮查询完成，请购票前重新核验。':'本轮已结束，部分区间尚未核验；已确认方案保留。',!result?.complete);}
    else if(event.startsWith('event: error')){final=true;queryState=data.result?'partial':'unavailable';status(data.message||'查询未完成，请稍后再试。',true);}
    else if(data.message)status(data.message);
   }
  }
  if(!final)throw Error('查询连接已中断，已收到的数据仅供参考，请重新查询。');
 }catch(e){queryState=e instanceof Error&&e.name==='AbortError'?'cancelled':'unavailable';status(e instanceof Error&&e.name==='AbortError'?'查询已停止。需要实时库存时请重新查询。':e instanceof Error?e.message:'查询未完成，请稍后再试。',true);}
 finally{if(['unavailable','cancelled'].includes(queryState))evidenceToken=undefined;setBusy(false);render();if(!result)$('plans').innerHTML='<div class="empty"><h3>暂未取得可核验的实时余票</h3><p>请稍后再试，或直接打开 12306 查询。</p></div>';}
}
$('query-form').addEventListener('submit',event=>{event.preventDefault();if(busy)return;void(async()=>{
 try{const from=await station('from'),to=await station('to');if(from.code===to.code)throw Error('出发站和到站不能相同。');const seats=selected('seats') as SeatType[],types=selected('types') as RailSearch['trainTypes'];if(!seats.length||!types.length)throw Error('至少选择一种车型与席别。');const middle=field('middle').value.trim()?await station('middle'):null;
  await run('search',{origin:from,destinations:[to],date:field('date').value,earliestTime:field('time').value,trainTypes:types,seats,passengerCount:Number(field('passengers').value),sameSeatOnly:field('same-seat').checked,includeTransfer:field('transfer').checked,transferStations:middle?[middle]:[],minTransferMinutes:Number(field('wait').value),allowOvernightTransfer:field('overnight').checked,includeLongTicket:field('long').checked,includeExtension:field('extension').checked});
 }catch(e){error(e instanceof Error?e.message:'查询条件无效。');}
})();});
function invalidate(){if(!busy){evidenceToken=undefined;assistantUi?.resetContext();if(result){queryState='unavailable';render();status('条件已更改，请重新查询取得新库存。',true);}}}
$('query-form').addEventListener('input',invalidate);$('query-form').addEventListener('change',invalidate);
$('swap').addEventListener('click',()=>{invalidate();const a=field('from').value;field('from').value=field('to').value;field('to').value=a;});
$('cancel').addEventListener('click',()=>abort?.abort());
$('more').addEventListener('click',()=>{showAll=true;render();});
$('sort').addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');if(button){sort=button.dataset.mode as RecommendationMode;showAll=false;for(const b of $('sort').querySelectorAll('button'))b.classList.toggle('active',b===button);render();}});
$('filter').addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]');if(button){kind=button.dataset.kind!;showAll=false;for(const b of $('filter').querySelectorAll('button'))b.classList.toggle('active',b===button);render();}});
$('plans').addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-recheck]');if(button&&input&&!busy){const plan=result?.plans.find(p=>p.id===button.dataset.recheck);if(plan)void run('recheck',input,plan);}});
for(const button of document.querySelectorAll<HTMLButtonElement>('.help'))button.addEventListener('click',()=>{const tip=$('tooltip');tip.textContent=button.title;tip.hidden=!tip.hidden&&tip.dataset.for===button.getAttribute('aria-label');tip.dataset.for=button.getAttribute('aria-label')||'';const r=button.getBoundingClientRect();tip.style.left=Math.max(12,Math.min(innerWidth-292,r.left-130))+'px';tip.style.top=Math.max(10,Math.min(innerHeight-140,r.bottom+9))+'px';});
document.addEventListener('click',event=>{if(!(event.target as HTMLElement).closest('.help'))$('tooltip').hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape')$('tooltip').hidden=true;});
setInterval(()=>{if(result&&!busy)render();},30000);

function formDraft():FormDraft{return {origin:field('from').value.trim(),destination:field('to').value.trim(),date:field('date').value,earliestTime:field('time').value,passengerCount:Number(field('passengers').value),seats:selected('seats'),trainTypes:selected('types'),includeTransfer:field('transfer').checked,sameSeatOnly:field('same-seat').checked,allowOvernightTransfer:field('overnight').checked,includeLongTicket:field('long').checked,includeExtension:field('extension').checked,middle:field('middle').value.trim(),minTransferMinutes:Number(field('wait').value)};}
function applySearch(search:RailSearch){
 field('from').value=search.origin.name;field('to').value=search.destinations[0].name;field('date').value=search.date;field('time').value=search.earliestTime;field('passengers').value=String(search.passengerCount??1);field('middle').value=search.transferStations?.[0]?.name??'';field('wait').value=String(search.minTransferMinutes??45);
 for(const cb of $('seats').querySelectorAll<HTMLInputElement>('input'))cb.checked=search.seats.includes(cb.value as SeatType);
 for(const cb of $('types').querySelectorAll<HTMLInputElement>('input'))cb.checked=search.trainTypes.includes(cb.value as 'G'|'D'|'C');
 for(const [id,value] of [['transfer',search.includeTransfer],['same-seat',search.sameSeatOnly],['overnight',search.allowOvernightTransfer],['long',search.includeLongTicket],['extension',search.includeExtension]] as const)field(id).checked=!!value;
}
const assistantUi:ReturnType<typeof initAssistant>=initAssistant({getForm:formDraft,getEvidence:()=>evidenceToken,setEvidence:token=>{evidenceToken=token;},setBusy:value=>{setBusy(value,'assistant');if(!value)render();},
 onSearch:search=>{input=search;result=null;evidenceToken=undefined;queryState='running';showAll=false;applySearch(search);$('plans').textContent='';$('tools').hidden=true;$('issues').hidden=true;$('more').hidden=true;$('other-status').textContent='';$('result-meta').textContent='';status('AI 助手正在按识别到的条件查询实时余票…');},
 onResult:data=>{input=data.input;result=data.result;evidenceToken=data.evidenceToken;queryState=result.complete?'complete':'partial';applySearch(input);render();status(result.complete?'本轮查询完成，请购票前重新核验。':'本轮已结束，部分区间尚未核验；已确认方案保留。',!result.complete);},
 onAnswer:memory=>{sort=memory.sort;for(const button of $('sort').querySelectorAll<HTMLButtonElement>('button'))button.classList.toggle('active',button.dataset.mode===sort);render();},
 onPlan:id=>{const found=result?.plans.find(p=>p.id===id);if(!found||!currentPlan(found,queryState,Date.now()))return false;kind='all';showAll=false;for(const b of $('filter').querySelectorAll<HTMLButtonElement>('button'))b.classList.toggle('active',b.dataset.kind==='all');render();let card=[...document.querySelectorAll<HTMLElement>('article[data-plan-id]')].find(p=>p.dataset.planId===id);if(!card){showAll=true;render();card=[...document.querySelectorAll<HTMLElement>('article[data-plan-id]')].find(p=>p.dataset.planId===id);}card?.scrollIntoView({behavior:'smooth',block:'center'});return true;},
 onError:message=>{if(queryState==='running'){queryState='unavailable';evidenceToken=undefined;status(message,true);if(!result)$('plans').innerHTML='<div class="empty"><h3>本轮暂未取得可核验的实时余票</h3><p>请重新查询，或直接打开 12306。</p></div>';}}
});
