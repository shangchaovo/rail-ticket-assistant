import {chromium, type BrowserContext, type Page, type Response} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import type {Adapter, SegmentQuote, Station, TicketLeg, TrainStop} from '../shared/rail-types.ts';
import {leftTicketUrl, officialAccess, officialAccessError, OFFICIAL_REQUEST_LIMIT, officialTicketPath, rotatedTicketPath, trainStopUrl} from './official-api.ts';
import {applyPrices, chinaDate, parseStations, parseStops, parseTickets, SourceError} from './parsers.ts';
import {transferCandidates} from './transfer-stations.ts';

export const OFFICIAL_PAGE='https://kyfw.12306.cn/otn/leftTicket/init';
export const STATION_FILE='https://kyfw.12306.cn/otn/resources/js/framework/station_name.js';
export const PROFILE=join(homedir(),'Library','Application Support','12306 Rail Assistant','browser-profile');
export type AdapterHooks={isCancelled?:()=>Promise<boolean>; onMessage?:(message:string)=>Promise<void>|void; waitForUser?:(message:string)=>Promise<void>;priceTrainNo?:string;priceLegs?:TicketLeg[]};
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

export class OfficialAdapter implements Adapter {
  private context?:BrowserContext;
  private page?:Page;
  private headed=false;
  private apiGap=0;
  private uiGap=0;
  private ticketPath='';
  private stationList:Station[]=[];
  private quotes=new Map<string,SegmentQuote[]>();
  private requests=0;
  private blocked?:'rate'|'verify'|'budget';
  constructor(private hooks:AdapterHooks={}){}
  configureForJob(hooks:AdapterHooks){this.hooks=hooks;this.quotes.clear();this.requests=0;this.blocked=undefined;}
  async open():Promise<void>{await this.session(false);}
  private async session(headed:boolean):Promise<void>{
    await this.check();
    if(this.page&&!this.page.isClosed()&&(this.headed===headed||this.headed))return;
    await this.context?.close().catch(()=>{});
    this.context=undefined;this.page=undefined;this.headed=headed;
    await mkdir(PROFILE,{recursive:true,mode:0o700});
    await this.check();
    this.context=await chromium.launchPersistentContext(PROFILE,{headless:!headed,acceptDownloads:false,chromiumSandbox:true});
    await this.check();
    this.page=await this.context.newPage();
    await this.check();
    await this.page.goto(OFFICIAL_PAGE,{waitUntil:'domcontentloaded',timeout:45_000});
    await this.learnTicketPath();
  }
  async close(){await this.context?.close();this.context=undefined;this.page=undefined;}
  async stations():Promise<Station[]>{
    if(this.stationList.length)return this.stationList;
    const response=await fetch(STATION_FILE,{signal:AbortSignal.timeout(20_000),redirect:'error'});
    if(!response.ok)throw new SourceError('官方站名文件暂时无法读取');
    this.stationList=parseStations(await response.text());return this.stationList;
  }
  async transferStations(from:Station,to:Station):Promise<Station[]>{
    const candidates=transferCandidates(from,to,await this.stations());
    if(candidates.limited)await this.hooks.onMessage?.('站点地理位置未完整匹配，本次使用有限实际枢纽候选；可指定中转站扩展核验。');
    return candidates.stations;
  }
  private async check(){if(await this.hooks.isCancelled?.())throw new SourceError('查询已取消');}
  private async pace(kind:'api'|'ui'){
    await this.check();
    const gap=kind==='api'?450:3_000;
    const previous=kind==='api'?this.apiGap:this.uiGap;
    await sleep(Math.max(0,gap-(Date.now()-previous)));
    if(kind==='api')this.apiGap=Date.now();else this.uiGap=Date.now();
    await this.check();
  }
  private async needsUser(message:string):Promise<void>{
    if(!this.hooks.waitForUser)throw new SourceError(message);
    await this.hooks.onMessage?.(message);await this.hooks.waitForUser(message);await this.check();
  }
  private request(){
    if(this.blocked)throw officialAccessError(this.blocked);
    if(this.requests>=OFFICIAL_REQUEST_LIMIT){this.blocked='budget';throw officialAccessError('budget');}
    this.requests++;
  }
  private async stopForAccess(access:'rate'|'verify'):Promise<never>{
    this.blocked=access;
    const error=officialAccessError(access);
    if(access==='verify'){
      // Show the ordinary official page for the owner. Resuming acknowledges the
      // manual action, but does not retry or continue this task's interval crawl.
      await this.session(true).catch(()=>{});
      if(this.hooks.waitForUser)await this.needsUser(error.message);
      else await this.hooks.onMessage?.(error.message);
    }
    throw error;
  }
  private async learnTicketPath(){
    const page=this.page!;
    try{await page.waitForFunction(()=>{
      const value=(globalThis as {CLeftTicketUrl?:unknown}).CLeftTicketUrl;
      return typeof value==='string'&&/leftTicket\/query[A-Z]?$/.test(value);
    },undefined,{timeout:8_000});}catch{/* A real query can still reveal the current path. */}
    const raw=await page.evaluate(()=>{
      const value=(globalThis as {CLeftTicketUrl?:unknown}).CLeftTicketUrl;
      return typeof value==='string'?value:'';
    }).catch(()=>'');
    const path=officialTicketPath(raw);
    if(path)this.ticketPath=path;
  }
  private async officialJson(url:string){
    await this.pace('api');
    this.request();
    let status=0,text='';
    try{
      const response=await this.page!.request.get(url,{timeout:15_000,maxRedirects:0,headers:{
        Accept:'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With':'XMLHttpRequest',
        Referer:OFFICIAL_PAGE,
      }});
      try{status=response.status();text=await response.text();}
      finally{await response.dispose();}
    }catch(error){
      if(error instanceof SourceError)throw error;
      const message=error instanceof Error?error.message:'';
      if(/redirect/i.test(message))return {status:302,payload:null,text:''};
      throw new SourceError('未取得本次查询的官方数据响应，不能据此判断无票');
    }
    let payload:unknown=null;
    try{payload=JSON.parse(text);}catch{payload=null;}
    return {status,payload,text:text.slice(0,12_000)};
  }
  private async selectStation(kind:'from'|'to',station:Station){
    const page=this.page!;const field=page.locator(kind==='from'?'#fromStationText':'#toStationText');
    await field.click();await field.fill(station.name);
    // This legacy autocomplete listens to keyboard events, not only input events.
    await field.press('End');await field.press('Space');await field.press('Backspace');
    await sleep(300);
    const candidate=page.locator('div[id^="citem_"]').filter({has:page.getByText(station.name,{exact:true})});
    let clicked=false;
    for(let i=0;i<await candidate.count();i++){if(await candidate.nth(i).isVisible()){await candidate.nth(i).click();clicked=true;break;}}
    if(!clicked){await field.press('ArrowDown');await field.press('Enter');}
    await field.press('Tab');
    const code=await page.locator(kind==='from'?'#fromStation':'#toStation').inputValue();
    if(code!==station.code)throw new SourceError(`官网未选中 ${station.name}，请在浏览器中检查站点后重试`);
  }
  private urlOf(r:Response){try{return new URL(r.url());}catch{return null;}}
  private async capture<T>(predicate:(r:Response)=>boolean,parse:(p:unknown)=>T,action:()=>Promise<void>):Promise<T>{
    const page=this.page!;
    this.request();
    const pending=page.waitForResponse(predicate,{timeout:25_000});
    // Attach a rejection handler before the UI action can fail.
    pending.catch(()=>{});
    await action();
    let response:Response;
    try{response=await pending;}catch{
      await this.check();
      const body=(await page.locator('body').innerText()).slice(0,12_000);
      const visibleLogin=await page.locator('input[type="password"]:visible').count()>0;
      const access=visibleLogin?'verify':officialAccess(0,null,body);
      if(access==='verify'||access==='rate')return this.stopForAccess(access);
      throw new SourceError('未取得本次查询的官方数据响应，不能据此判断无票');
    }
    const path=officialTicketPath(this.urlOf(response)?.pathname??'');
    if(path)this.ticketPath=path;
    const text=await response.text();
    let payload:unknown=null;try{payload=JSON.parse(text);}catch{/* Access checks below also inspect HTML verification pages. */}
    const access=officialAccess(response.status(),payload,text);
    if(access==='verify'||access==='rate')return this.stopForAccess(access);
    if(!response.ok())throw new SourceError(`12306 查询暂时不可用（HTTP ${response.status()}）`);
    if(payload===null)throw new SourceError('官方返回了非数据页面，不能据此判断余票');
    await this.check();return parse(payload);
  }
  private async prepare(from:Station,to:Station,date:string){
    chinaDate(date);const stations=await this.stations();
    for(const s of [from,to])if(!stations.some(x=>x.code===s.code&&x.name===s.name))throw new SourceError('输入站点与官方站名表不一致');
  }
  private missingCheckedPrice(rows:SegmentQuote[]){
    const id=this.hooks.priceTrainNo;
    return !!id&&rows.some(q=>(this.hooks.priceLegs
      ? this.hooks.priceLegs.some(leg=>(leg.train?.trainNo??id)===q.train.trainNo&&(!leg.train||leg.train.serviceDate===q.train.serviceDate)&&leg.from.code===q.from.code&&leg.to.code===q.to.code&&leg.departureIso===q.departureIso
        &&q.seats[leg.seat].status==='available'&&q.seats[leg.seat].price===null)
      : q.train.trainNo===id&&Object.values(q.seats).some(s=>s.status==='available'&&s.price===null)));
  }
  private async ensureQueryForm(){
    const page=this.page!;
    if(/login\.html|\/passport\//i.test(page.url())||await page.locator('input[type="password"]:visible').count())return this.stopForAccess('verify');
    if(await page.locator('#query_ticket').count())return;
    const body=(await page.locator('body').innerText()).slice(0,12_000);
    const access=officialAccess(0,null,body);
    if(access==='verify'||access==='rate')return this.stopForAccess(access);
    throw new SourceError('官网查询表单不可用，当前区间余票未知');
  }
  private async queryByApi(from:Station,to:Station,date:string){
    await this.hooks.onMessage?.(`查询 ${from.name} → ${to.name}（${date}）`);
    let rotated=false;
    for(;;){
      const got=await this.officialJson(leftTicketUrl(this.ticketPath,from,to,date));
      const access=officialAccess(got.status,got.payload,got.text);
      if(access==='ok')return parseTickets(got.payload,from,to,date);
      const next=rotatedTicketPath(got.payload);
      if(access==='rotate'&&next&&next!==this.ticketPath&&!rotated){this.ticketPath=next;rotated=true;continue;}
      if(access==='rate'||access==='verify')return this.stopForAccess(access);
      throw new SourceError('未取得本次查询的官方数据响应，不能据此判断无票');
    }
  }
  private async queryByClick(from:Station,to:Station,date:string,key:string){
    await this.session(true);await this.pace('ui');
    await this.ensureQueryForm();
    await this.selectStation('from',from);await this.selectStation('to',to);
    const dateField=this.page!.locator('input#train_date');
    await dateField.fill(date);await dateField.press('Tab');
    if(await dateField.inputValue()!==date)throw new SourceError('官网未接受所选日期');
    await this.hooks.onMessage?.(`查询 ${from.name} → ${to.name}（${date}）`);
    const rows=await this.capture(r=>{
      const u=this.urlOf(r);return !!u&&u.hostname==='kyfw.12306.cn'&&/^\/otn\/leftTicket\/query[A-Z]?$/.test(u.pathname)&&u.searchParams.get('leftTicketDTO.train_date')===date&&u.searchParams.get('leftTicketDTO.from_station')===from.code&&u.searchParams.get('leftTicketDTO.to_station')===to.code;
    },p=>parseTickets(p,from,to,date),()=>this.page!.locator('#query_ticket').click());
    for(const quote of rows.filter(q=>this.missingCheckedPrice([q]))){await this.readPrice(quote);}
    this.quotes.set(key,rows);return rows;
  }
  async query(from:Station,to:Station,date:string):Promise<SegmentQuote[]>{
    await this.prepare(from,to,date);
    const key=`${from.code}:${to.code}:${date}`;
    // Within one search, reuse an identical completed snapshot; recheck uses a fresh adapter.
    if(this.blocked)throw officialAccessError(this.blocked);
    const cached=this.quotes.get(key);if(cached)return cached;
    await this.session(false);
    if(!this.ticketPath)await this.learnTicketPath();
    if(this.ticketPath){
      const rows=await this.queryByApi(from,to,date);
      if(!this.missingCheckedPrice(rows)){this.quotes.set(key,rows);return rows;}
    }
    return this.queryByClick(from,to,date,key);
  }
  private async readPrice(quote:SegmentQuote){
    await this.check();const page=this.page!;
    if(Object.values(quote.seats).every(s=>s.status==='unsupported'||s.price!==null))return;
    const controls=page.locator('span.lookup[onclick="showTicketPrice(this)"]');
    try{await controls.first().waitFor({state:'attached',timeout:3_000});}catch{return;}
    let control:ReturnType<Page['locator']>|undefined;
    for(let i=0;i<await controls.count();i++){
      const el=controls.nth(i),id=await el.getAttribute('id');
      const prefix=`${quote.train.trainNo}_${String(quote.fromIndex).padStart(2,'0')}_${String(quote.toIndex).padStart(2,'0')}_`;
      if(id?.startsWith(prefix)){control=el;break;}
    }
    if(!control)return;
    // Current official pages expose price expansion on visible inventory cells;
    // the legacy lookup span has zero size. Never force-click hidden elements.
    const cells=control.locator('xpath=ancestor::tr').locator('td[onclick="showTicketPrice(this)"]');
    let visibleControl:ReturnType<Page['locator']>|undefined;
    for(let i=0;i<await cells.count();i++){
      const cell=cells.nth(i),text=(await cell.innerText()).trim();
      if(text!=='候补'&&text!=='--'&&await cell.isVisible()){visibleControl=cell;break;}
    }
    if(!visibleControl){try{await control.locator('..').hover({timeout:3_000});if(await control.isVisible())visibleControl=control;}catch{} }
    if(!visibleControl)return;
    await this.pace('ui');
    try{
      await visibleControl.click();
      const prefix=`${quote.train.trainNo}_${String(quote.fromIndex).padStart(2,'0')}_${String(quote.toIndex).padStart(2,'0')}`;
      const priceRow=page.locator(`[id="price_${prefix}"]`);
      await priceRow.waitFor({state:'visible',timeout:5_000});
      const columns=await priceRow.locator('td').evaluateAll(es=>es.map(e=>({span:e.getAttribute('colspan'),text:(e as HTMLElement).innerText.trim()})));
      // The official table: four journey columns, eleven seat columns, remarks.
      if(columns.length!==13||columns[0].span!=='4'||columns.slice(1).some(c=>c.span!==null))return;
      applyPrices({status:true,data:{A9:columns[1].text,M:columns[3].text,O:columns[4].text,WZ:columns[10].text}},quote);
    }catch(error){if(error instanceof SourceError&&error.message==='查询已取消')throw error;/* Unknown prices stay null. */}
  }
  private async stopsByClick(quote:SegmentQuote){
    await this.session(true);await this.pace('ui');
    await this.ensureQueryForm();
    const date=quote.departureIso.slice(0,10);
    const currentFrom=await this.page!.locator('#fromStation').inputValue(),currentTo=await this.page!.locator('#toStation').inputValue(),currentDate=await this.page!.locator('input#train_date').inputValue();
    if(currentFrom!==quote.from.code||currentTo!==quote.to.code||currentDate!==date){
      const key=`${quote.from.code}:${quote.to.code}:${date}`;
      this.quotes.delete(key);
      await this.queryByClick(quote.from,quote.to,date,key);
    }
    const links=this.page!.locator('a.number[onclick]');let link:ReturnType<Page['locator']>|undefined;
    for(let i=0;i<await links.count();i++){
      const item=links.nth(i),onclick=await item.getAttribute('onclick');
      // Treat inline metadata as text; never evaluate it.
      if(onclick?.includes(`'${quote.train.trainNo}'`)&&onclick.includes(`'${quote.from.code}'`)&&onclick.includes(`'${quote.to.code}'`)&&onclick.includes(`'${quote.train.serviceDate.replaceAll('-','')}'`)){link=item;break;}
    }
    if(!link)throw new SourceError('官网经停详情控件缺少可核验的列车身份');
    return this.capture(r=>{const u=this.urlOf(r);return !!u&&u.hostname==='kyfw.12306.cn'&&u.pathname==='/otn/czxx/queryByTrainNo'&&u.searchParams.get('train_no')?.trim()===quote.train.trainNo&&u.searchParams.get('from_station_telecode')===quote.from.code&&u.searchParams.get('to_station_telecode')===quote.to.code&&u.searchParams.get('depart_date')===quote.train.serviceDate;},p=>parseStops(p,quote,this.stationList),()=>link!.click());
  }
  async stops(quote:SegmentQuote):Promise<TrainStop[]>{
    if(this.blocked)throw officialAccessError(this.blocked);
    if(!this.stationList.length)await this.stations();
    await this.session(false);
    const got=await this.officialJson(trainStopUrl(quote));
    const access=officialAccess(got.status,got.payload,got.text);
    if(access==='ok')return parseStops(got.payload,quote,this.stationList);
    if(access==='rate'||access==='verify')return this.stopForAccess(access);
    // Preserve the existing official UI fallback only for a changed data response,
    // never as a way to retry a blocked session.
    if(got.status===200&&got.payload&&typeof got.payload==='object')return this.stopsByClick(quote);
    throw new SourceError('官方经停数据未通过业务校验');
  }
}
