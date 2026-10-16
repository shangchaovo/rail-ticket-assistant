import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import identity from '../browser-extension/identity.json' with {type:'json'};
import {publicApiUrl,publicRequestOptions} from '../cloud/public/transport.ts';
import {publicClientOrigin,extensionRequest} from '../cloud/public/client-origin.ts';
import worker from '../cloud/public/worker.ts';

const manifest=JSON.parse(readFileSync('browser-extension/manifest.json','utf8'));
test('extension has a stable identity, only one service host, and no page or Cookie access',()=>{
 const derived=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 assert.equal(derived,identity.id);assert.equal(identity.origin,'chrome-extension://'+derived);
 assert.equal(manifest.manifest_version,3);assert.deepEqual(manifest.permissions,['sidePanel']);assert.deepEqual(manifest.host_permissions,[identity.serviceOrigin+'/*']);
 for(const field of ['content_scripts','externally_connectable','web_accessible_resources','optional_permissions'])assert.ok(!(field in manifest));
 assert.match(manifest.content_security_policy.extension_pages,/script-src 'self'/);assert.ok(!manifest.content_security_policy.extension_pages.includes('unsafe-eval'));
 assert.ok(existsSync('browser-extension/'+manifest.background.service_worker));assert.equal(manifest.side_panel.default_path,'panel.html');
});
test('extension transport pins all requests to public APIs and always omits browser credentials',()=>{
 assert.equal(publicApiUrl('/api/public/query',true),identity.serviceOrigin+'/api/public/query');
 assert.equal(publicApiUrl('/api/public/stations?q=%E6%9D%AD%E5%B7%9E',true),identity.serviceOrigin+'/api/public/stations?q=%E6%9D%AD%E5%B7%9E');
 assert.equal(publicApiUrl('/api/public/assistant',false),'/api/public/assistant');
 for(const path of ['/api/jobs','/api/assistant','/api/device','/api/public/../assistant','//foreign.test/api/public/query','https://foreign.test/api/public/query'])assert.throws(()=>publicApiUrl(path,true));
 assert.equal(publicRequestOptions({credentials:'include'},true).credentials,'omit');assert.equal(publicRequestOptions({},true).mode,'cors');
});
test('public website and extension both drop private cookies and credential headers',()=>{
 for(const extension of [false,true]){
  const options=publicRequestOptions({credentials:'include',headers:{Cookie:'rail_session=test-only',Authorization:'Bearer test-only','X-Rail-Lease-Token':'test-only','oai-authenticated-user-id':'test-only',Accept:'application/json','Content-Type':'application/json'}},extension);
  assert.equal(options.credentials,'omit');
  const headers=new Headers(options.headers);
  for(const name of ['Cookie','Authorization','X-Rail-Lease-Token','oai-authenticated-user-id'])assert.equal(headers.get(name),null);
  assert.equal(headers.get('Accept'),'application/json');assert.equal(headers.get('Content-Type'),'application/json');
 }
});
test('toolbar service worker configures a persistent side panel without inspecting tabs',async()=>{
 const calls:unknown[]=[],listeners:Record<string,()=>Promise<void>>={};
 runInNewContext(readFileSync('browser-extension/background.js','utf8'),{chrome:{sidePanel:{setPanelBehavior:async(value:unknown)=>{calls.push(value);}},runtime:{onInstalled:{addListener:(fn:()=>Promise<void>)=>{listeners.install=fn;}},onStartup:{addListener:(fn:()=>Promise<void>)=>{listeners.startup=fn;}}}}});
 await listeners.install();await listeners.startup();assert.equal(calls.length,3);for(const value of calls)assert.equal((value as {openPanelOnActionClick:boolean}).openPanelOnActionClick,true);
});
test('only the pinned extension origin can use public cross-origin APIs',async()=>{
 const env={PUBLIC_ENABLED:'true',AI_ASSISTANT_ENABLED:'false',ASSETS:{fetch:async()=>new Response('asset')}} as never,ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
 const make=(origin:string,path='/api/public/status',method='GET',headers:Record<string,string>={})=>new Request(identity.serviceOrigin+path,{method,headers:{Origin:origin,...headers}});
 const allowed=await worker.fetch(make(identity.origin),env,ctx);assert.equal(allowed.status,200);assert.equal(allowed.headers.get('access-control-allow-origin'),identity.origin);assert.equal(allowed.headers.get('access-control-allow-credentials'),null);
 const preflight=await worker.fetch(make(identity.origin,'/api/public/query','OPTIONS',{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type, accept'}),env,ctx);assert.equal(preflight.status,204);
 for(const origin of ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','https://foreign.test','null']){
  assert.equal(publicClientOrigin(make(origin)),false);
  const rejected=await worker.fetch(make(origin,'/api/public/query','OPTIONS',{'Access-Control-Request-Method':'POST'}),env,ctx);assert.equal(rejected.status,403);assert.equal(rejected.headers.get('access-control-allow-origin'),null);
 }
 const headers=await worker.fetch(make(identity.origin,'/api/public/query','OPTIONS',{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization'}),env,ctx);assert.equal(headers.status,403);
 assert.equal(extensionRequest(new Request('https://preview.test/api/public/query',{headers:{Origin:identity.origin}})),false);
 for(const path of ['/api/jobs','/api/assistant','/api/device','/downloads/rail-helper.zip']){
  const response=await worker.fetch(make(identity.origin,path),env,ctx);assert.equal(response.status,404);assert.equal(response.headers.get('access-control-allow-origin'),null);
 }
});
