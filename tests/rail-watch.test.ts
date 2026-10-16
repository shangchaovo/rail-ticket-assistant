import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {tickWatches,watchTimes,watchOutcome,flushNotifications,enqueueNotification,barkKey,hasFreshTickets,pruneResultHistory} from '../lib/rail-watch.ts';
import type {RailJob,RailSearch,SearchResult,TicketPlan} from '../lib/rail-types.ts';
const now=Date.parse('2026-10-06T01:00:00Z'),stamp=new Date(now).toISOString();
const input:RailSearch={origin:{name:'杭州东',code:'HGH'},destinations:[{name:'温州南',code:'VRH'}],date:'2026-10-07',earliestTime:'00:00',seats:['second'],trainTypes:['G'],includeLongTicket:true,includeExtension:false,passengerCount:2,sameSeatOnly:true};
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of ['0000_naive_jackpot.sql','0003_watches.sql'])sqlite.exec(readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
 const db={prepare(sql:string){let args:(string|number|null)[]=[];const statement={bind(...values:(string|number|null)[]){args=values;return statement;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};return statement;}} as unknown as D1Database;
 sqlite.prepare("INSERT INTO devices (id,owner_id,token_hash,name,message,last_seen,created_at) VALUES ('device','owner','synthetic','test','',?,?)").run(stamp,stamp);
 const add=(id='watch',owner='owner')=>sqlite.prepare("INSERT INTO watches (id,owner_id,name,input_json,start_at,interval_seconds,end_at,next_run_at,message,site_origin,created_at,updated_at) VALUES (?,?,?, ?,?,120,?,?,'','https://rail.example',?,?)").run(id,owner,'Test journey',JSON.stringify(input),stamp,new Date(now+86400_000).toISOString(),stamp,stamp,stamp);
 add();return {db,sqlite,add};
}
test('persistent due watches create one job, catch up once after sleep, and stop at end',async()=>{
 const f=fixture();try{
  await tickWatches(f.db,undefined,now);await tickWatches(f.db,undefined,now);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n,1);
  await tickWatches(f.db,undefined,now+600_000);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n,1);
  assert.match(String(f.sqlite.prepare('SELECT message FROM watches').get()?.message),/离线|休眠/);
  f.sqlite.prepare("UPDATE jobs SET status='complete'").run();f.sqlite.prepare('UPDATE devices SET last_seen=?').run(new Date(now+600_000).toISOString());
  await tickWatches(f.db,undefined,now+600_000);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n,2);
  await tickWatches(f.db,undefined,now+86400_000);assert.equal(f.sqlite.prepare('SELECT status FROM watches').get()?.status,'completed');assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'").get()?.n,0);
 }finally{f.sqlite.close();}
});
test('owner isolation, manual queue limit and paused watches cannot create jobs',async()=>{
 const f=fixture();try{
  f.add('other','stranger');await tickWatches(f.db,'stranger',now);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n,0);
  for(let n=0;n<3;n++)f.sqlite.prepare("INSERT INTO jobs (id,owner_id,status,input_json,message,created_at,updated_at) VALUES (?,'owner','queued','{}','',?,?)").run('manual'+n,stamp,stamp);
  await tickWatches(f.db,'owner',now);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n,3);
  f.sqlite.prepare("UPDATE jobs SET status='complete'").run();f.sqlite.prepare("UPDATE watches SET status='paused'").run();await tickWatches(f.db,'owner',now);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n,3);
 }finally{f.sqlite.close();}
});
test('lease expiry without an open page retains partial data and retries only after next due time',async()=>{
 const f=fixture();try{
  await tickWatches(f.db,undefined,now);f.sqlite.prepare("UPDATE jobs SET status='running',lease_token='lease',lease_until=?,result_json=?").run(new Date(now-1).toISOString(),'{"plans":[]}');
  await tickWatches(f.db,undefined,now);const row=f.sqlite.prepare('SELECT * FROM jobs').get();assert.equal(row?.status,'unavailable');assert.equal(row?.result_json,'{"plans":[]}');assert.equal(row?.lease_token,null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n,1);
 }finally{f.sqlite.close();}
});
function result(kind='direct',fetchedAt=stamp):SearchResult{
 const p={kind,uncovered:null,legs:[{inventory:{status:'available',count:2},departureIso:'2026-10-07T10:00:00+08:00',fetchedAt}]} as TicketPlan;
 return {plans:[p],observations:[],complete:false,issues:[],completedAt:stamp};
}
test('only fresh, fully covered tickets satisfying passenger count trigger a watch',()=>{
 const j={createdAt:stamp,input};assert.ok(hasFreshTickets(result(),j,now));
 for(const r of [result('extension'),result('direct','2026-10-05T01:00:00Z')])assert.equal(hasFreshTickets(r,j,now),false);
 const unknown=result();delete unknown.plans[0].legs[0].inventory.count;assert.equal(hasFreshTickets(unknown,j,now),false);
 const one=result();one.plans[0].legs[0].inventory.count=1;assert.equal(hasFreshTickets(one,j,now),false);
 assert.equal(hasFreshTickets(result(),j,now+2*86400_000),false);
});
test('watch availability transition stops default watch and queues a single notification',async()=>{
 const f=fixture();try{
  // Use current timestamps because live outcomes intentionally reject old data.
  const t=new Date().toISOString(),future=new Date(Date.now()+3600_000).toISOString();await tickWatches(f.db,undefined,now);const j=f.sqlite.prepare('SELECT * FROM jobs').get()!;
  const job={id:String(j.id),watchId:'watch',createdAt:t,input} as RailJob;
  const r=result('direct',t);r.plans[0].legs[0].departureIso=future;
  await watchOutcome(f.db,job,'running','已发现',r);await watchOutcome(f.db,job,'partial','收束',r);
  assert.equal(f.sqlite.prepare('SELECT status FROM watches').get()?.status,'completed');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_events').get()?.n,1);
 }finally{f.sqlite.close();}
});
test('Bark credentials are restricted, not echoed, and retries are bounded and deduplicated',async()=>{
 for(const value of ['http://api.day.app/abcdefgh','https://api.day.app.evil/abcdefgh','https://localhost/abcdefgh','https://api.day.app/abcdefgh?token=1','https://user@api.day.app/abcdefgh'])assert.throws(()=>barkKey(value));
 assert.equal(barkKey('https://api.day.app/synthetic-key'),'synthetic-key');
 const f=fixture();try{
  f.sqlite.prepare("INSERT INTO notification_settings VALUES ('owner',1,'synthetic-key',?)").run(stamp);
  await enqueueNotification(f.db,'owner','event','verification','需要验证','回到Mac','https://rail.example',now);await enqueueNotification(f.db,'owner','event','verification','需要验证','回到Mac','https://rail.example',now);
  let sent=0;const bad=(async()=>{sent++;throw new Error('offline');}) as typeof fetch;
  for(const at of [now,now+60_000,now+360_000,now+720_000])await flushNotifications(f.db,bad,at);
  assert.equal(sent,3);assert.equal(f.sqlite.prepare('SELECT delivery_status FROM notification_events').get()?.delivery_status,'failed');
  await enqueueNotification(f.db,'owner','second','tickets','有票','复核','https://rail.example',now);
  const good=(async(url,init)=>{assert.equal(url,'https://api.day.app/push');assert.equal(init?.redirect,'error');assert.equal(JSON.parse(String(init?.body)).device_key,'synthetic-key');return Response.json({code:200});}) as typeof fetch;
  await flushNotifications(f.db,good,now);assert.equal(f.sqlite.prepare("SELECT delivery_status FROM notification_events WHERE event_key='second'").get()?.delivery_status,'sent');
 }finally{f.sqlite.close();}
});
test('time windows and polling intervals reject invalid and expired configurations',()=>{
 assert.equal(watchTimes(input,stamp,'2026-10-07T21:00:00+08:00',120,now).nextRunAt,stamp);
 for(const seconds of [0,59,3601,120.1])assert.throws(()=>watchTimes(input,stamp,'2026-10-07T21:00:00+08:00',seconds,now));
 for(const end of [stamp,'invalid','2026-10-08T00:00:00+08:00'])assert.throws(()=>watchTimes(input,stamp,end,120,now));
});
test('concurrent notification flushes recheck due time and never consume stale retry counts',async()=>{
 const f=fixture();try{
  f.sqlite.prepare("INSERT INTO notification_settings VALUES ('owner',1,'synthetic-key',?)").run(stamp);
  await enqueueNotification(f.db,'owner','race','tickets','有票','复核','https://rail.example',now);
  let selected=0,releaseFirst!:()=>void,releaseSecond!:()=>void;
  const bothSelected=new Promise<void>(resolve=>releaseFirst=resolve),firstFailed=new Promise<void>(resolve=>releaseSecond=resolve);
  const prepare=f.db.prepare.bind(f.db);
  f.db.prepare=((sql:string)=>{
   const statement=prepare(sql);
   if(sql.startsWith('SELECT e.*')){
    const all=statement.all.bind(statement);
    statement.all=(async()=>{const r=await all();selected++;if(selected===1){await bothSelected;}else{releaseFirst();await firstFailed;}return r;}) as typeof statement.all;
   }else if(sql.startsWith('UPDATE notification_events SET delivery_status=?')){
    const run=statement.run.bind(statement);statement.run=(async()=>{const r=await run();releaseSecond();return r;}) as typeof statement.run;
   }
   return statement;
  }) as typeof f.db.prepare;
  let sends=0;const send=(async()=>{sends++;throw new Error('offline');}) as typeof fetch;
  await Promise.all([flushNotifications(f.db,send,now),flushNotifications(f.db,send,now)]);
  assert.equal(sends,1);const row=f.sqlite.prepare('SELECT attempts,next_attempt_at FROM notification_events').get();assert.equal(row?.attempts,1);assert.equal(row?.next_attempt_at,new Date(now+60_000).toISOString());
 }finally{f.sqlite.close();}
});
test('recurring results are bounded while latest watched results and task metadata remain',async()=>{
 const f=fixture();try{
  for(let n=0;n<80;n++)f.sqlite.prepare("INSERT INTO jobs (id,owner_id,status,input_json,result_json,message,created_at,updated_at) VALUES (?,'owner','complete','{}','synthetic','',?,?)").run('history'+n,new Date(now+n*1000).toISOString(),stamp);
  f.sqlite.prepare("UPDATE watches SET last_job_id='history0'").run();
  await pruneResultHistory(f.db,'owner',now);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs WHERE result_json IS NOT NULL').get()?.n,51);
  assert.equal(f.sqlite.prepare("SELECT result_json FROM jobs WHERE id='history0'").get()?.result_json,'synthetic');
  assert.equal(f.sqlite.prepare("SELECT status FROM jobs WHERE id='history1'").get()?.status,'unavailable');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n,80);
 }finally{f.sqlite.close();}
});
test('old completed watches cannot indefinitely exempt all jobs from metadata retention',async()=>{
 const f=fixture();try{
  const old=new Date(now-40*86400_000).toISOString();
  f.sqlite.prepare('DELETE FROM watches').run();
  for(let n=0;n<250;n++){
   f.sqlite.prepare("INSERT INTO jobs (id,owner_id,status,input_json,message,created_at,updated_at) VALUES (?,'owner','complete','{}','',?,?)").run('old'+n,old,old);
   f.sqlite.prepare("INSERT INTO watches (id,owner_id,name,input_json,start_at,interval_seconds,end_at,next_run_at,status,last_job_id,message,site_origin,created_at,updated_at) VALUES (?,'owner','old','{}',?,120,?,?,'completed',?,'','https://rail.example',?,?)").run('oldwatch'+n,old,old,old,'old'+n,new Date(Date.parse(old)+n*1000).toISOString(),old);
  }
  await tickWatches(f.db,undefined,now);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()?.n,30);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM watches WHERE last_job_id IS NOT NULL').get()?.n,30);
 }finally{f.sqlite.close();}
});
