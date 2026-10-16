// Local integration fixtures only. Never point these synthetic inventories at a live website.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync} from 'node:fs';
const origin=process.argv[2]||'http://127.0.0.1:5183';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw new Error('Only a local test service is allowed');
let cookie='',token='',runner=randomUUID(),checks=0;
async function call(path,method='GET',body,expected=200,helper=false,extra={}){
 const headers={Origin:origin,...extra};if(cookie&&!helper)headers.Cookie=cookie;
 if(helper){headers.Authorization='Bearer '+token;headers['X-Rail-Runner-Id']=runner;}
 if(body!==undefined)headers['Content-Type']='application/json';
 const response=await fetch(origin+'/api/'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
 assert.equal(response.status,expected,`${method} /api/${path} returned ${response.status}`);checks++;
 const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];
 return response.json();
}
await call('watches','GET',undefined,401);
await call('auth','POST',{password:'synthetic-local-verification-only'});
const tomorrow=new Date(Date.now()+86400_000).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
const input={origin:{name:'杭州东',code:'HGH'},destinations:[{name:'温州南',code:'VRH'}],date:tomorrow,earliestTime:'00:00',trainTypes:['G'],seats:['second'],includeLongTicket:true,includeExtension:false,passengerCount:2,sameSeatOnly:true};
const paired=await call('device','POST',{deviceName:'Local integration fixture'},201);token=paired.deviceToken;
await call('helper/claim','POST',{},200,true);
const other=randomUUID(),oldRunner=runner;runner=other;await call('helper/claim','POST',{},409,true);runner=oldRunner;
const created=await call('watches','POST',{input,startAt:new Date(Date.now()-1000).toISOString(),endAt:tomorrow+'T23:59:00+08:00',intervalSeconds:60,stopOnAvailable:true},201);
let scheduledJobId;
if(process.argv.includes('--schedule')){
 const response=await fetch(origin+'/cdn-cgi/handler/scheduled?cron='+encodeURIComponent('* * * * *'));assert.equal(response.status,200);assert.equal(await response.text(),'ok');checks++;
 const path='.wrangler/cloudflare-state/v3/d1/miniflare-D1DatabaseObject/',file=readdirSync(path).find(n=>n.endsWith('.sqlite')&&n!=='metadata.sqlite');
 const db=new DatabaseSync(path+file,{readOnly:true});
 try{const row=db.prepare("SELECT id FROM jobs WHERE watch_id=? AND status='queued'").get(created.watch.id);assert.ok(row,'scheduled handler queued without a page poll or helper claim');scheduledJobId=row.id;}finally{db.close();}
}
const first=await call('helper/claim','POST',{},200,true);assert.equal(first.job.watchId,created.watch.id);
if(scheduledJobId)assert.equal(first.job.id,scheduledJobId);
const statusHeaders={'X-Rail-Job-Version':String(first.job.version),'X-Rail-Lease-Token':first.leaseToken};
const update={leaseToken:first.leaseToken,version:first.job.version,message:'Local fixture requires human verification'};
await call(`helper/jobs/${first.job.id}/progress`,'POST',{...update,status:'waiting_user'},200,true);
const state=await call('helper/state');assert.equal(state.helper.waitingJobId,first.job.id);
await call('helper/resume','POST',{jobId:first.job.id});
const resumed=await call(`helper/jobs/${first.job.id}/status`,'GET',undefined,200,true,statusHeaders);assert.equal(resumed.resumeVersion,1);
await call(`helper/jobs/${first.job.id}/progress`,'POST',{...update,status:'partial'},400,true);
await call('notifications','PUT',{enabled:false,barkUrl:'https://localhost/invalid-key'},400);
const notice=await call('notifications','PUT',{enabled:false,barkUrl:'https://api.day.app/synthetic-local-key'});assert.equal(notice.barkUrl,null);assert.equal(notice.configured,true);
const fetchedAt=new Date().toISOString(),departureIso=tomorrow+'T10:00:00+08:00',arrivalIso=tomorrow+'T11:00:00+08:00';
const train={trainNo:'synthetic-local-only',trainCode:'G9999',serviceDate:tomorrow,runId:'synthetic-local-only-run'};
const unavailable={status:'sold_out',price:null};
const quote={train,from:input.origin,to:input.destinations[0],fromIndex:0,toIndex:1,departureIso,arrivalIso,canBuy:true,seats:{business:unavailable,first:unavailable,second:{status:'available',price:10},standing:unavailable},fetchedAt,source:'12306'};
const result={plans:[],observations:[quote],complete:true,issues:[],completedAt:fetchedAt};
await call(`helper/jobs/${first.job.id}/result`,'POST',{...update,status:'complete',result},400,true);
quote.seats.second.count=2;
const plan={id:'synthetic-local-fixture',kind:'direct',train,origin:input.origin,target:input.destinations[0],destinationRank:0,departureIso,arrivalIso,legs:[{from:quote.from,to:quote.to,seat:'second',inventory:quote.seats.second,departureIso,arrivalIso,fetchedAt}],route:[{station:quote.from,index:0,arrivalIso:null,departureIso},{station:quote.to,index:1,arrivalIso,departureIso:null}],shortEndIndex:1,totalPrice:10,uncovered:null,fetchedFrom:fetchedAt,fetchedTo:fetchedAt,relationEvidence:'Synthetic local integration fixture only',warning:null};
result.plans=[plan];await call(`helper/jobs/${first.job.id}/result`,'POST',{...update,status:'complete',result},200,true);
const watched=await call('watches');assert.equal(watched.watches.find(w=>w.id===created.watch.id).status,'completed');
const done=await call(`jobs/${first.job.id}`);assert.equal(done.job.result.plans.length,1);
await call(`watches/${created.watch.id}`,'DELETE');
const paused=await call('watches','POST',{input,startAt:new Date(Date.now()-1000).toISOString(),endAt:tomorrow+'T23:59:00+08:00',intervalSeconds:60},201);
await call(`watches/${paused.watch.id}`,'PATCH',{status:'paused'});
const empty=await call('helper/claim','POST',{},200,true);assert.equal(empty.job,null);
await call(`watches/${paused.watch.id}`,'DELETE');
await call('helper/release','POST',{},200,true);await call('helper/claim','POST',{},409,true);runner=other;await call('helper/claim','POST',{},200,true);
await call('device','DELETE');await call('helper/claim','POST',{},401,true);
const replacement=await call('device','POST',{deviceName:'Replacement local fixture'},201);const oldToken=token;token=replacement.deviceToken;
await call('helper/claim','POST',{},200,true);token=oldToken;await call('helper/claim','POST',{},401,true);
token=replacement.deviceToken;await call('helper/release','POST',{},200,true);await call('device','DELETE');
await call('notifications','PUT',{enabled:false,barkUrl:''});
console.log(JSON.stringify({checks,passed:true,scheduledHandler:!!scheduledJobId,officialRequests:0,actualPushes:0,fixtures:'local isolated D1 only'}));
