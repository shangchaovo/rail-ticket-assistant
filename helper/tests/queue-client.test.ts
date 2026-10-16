import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {QueueClient} from '../src/queue-client.ts';
import type {RailJob,SearchResult} from '../shared/rail-types.ts';
import {unpackResult} from '../shared/rail-wire.ts';
test('状态续租传版本与租约，本地请求不发送 Sites 服务凭据',async()=>{
  const requests:{path:string;headers:Record<string,unknown>;body:string}[]=[];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({path:req.url||'',headers:req.headers,body});res.writeHead(200,{'content-type':'application/json'});res.end(req.url==='/api/helper/health'?JSON.stringify({ready:true,queue:'ready'}):JSON.stringify({cancelled:false}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address==='object');
  try{
    const client=new QueueClient({provider:'sites',origin:`http://127.0.0.1:${address.port}`,deviceId:'synthetic-device',deviceName:'test',deviceToken:'synthetic-device-token',serviceToken:'synthetic-site-token'});
    await client.health();await client.status({id:'test-job',version:7} as RailJob,'synthetic-lease');
    assert.equal(requests[1].headers['x-rail-job-version'],'7');assert.equal(requests[1].headers['x-rail-lease-token'],'synthetic-lease');assert.equal(requests[1].headers.authorization,'Bearer synthetic-device-token');
    assert.equal(requests[1].headers['oai-sites-authorization'],undefined);assert.equal(requests[1].body,'');
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('Cloudflare 拦截独立显示，不误报设备令牌或队列故障',async()=>{
  const server=createServer((_req,res)=>{res.writeHead(403,{'content-type':'text/html','cf-ray':'test-ray-LHR'});res.end('<title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1>');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address==='object');
  try{
    const client=new QueueClient({provider:'cloudflare',origin:`http://127.0.0.1:${address.port}`,deviceId:'synthetic-device',deviceName:'test',deviceToken:'synthetic-device-token',serviceToken:''});
    await assert.rejects(client.health(),error=>error instanceof Error&&error.message.includes('Cloudflare')&&error.message.includes('test-ray-LHR')&&!error.message.includes('请检查设备授权'));
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('Cloudflare 只发送设备 Bearer，丢弃旧 Sites 凭据且禁止跨站重定向',async()=>{
  const original=globalThis.fetch;
  const requests:{url:string;headers:Headers;redirect:RequestRedirect|undefined}[]=[];
  globalThis.fetch=async(input,init)=>{requests.push({url:String(input),headers:new Headers(init?.headers),redirect:init?.redirect});return Response.json({job:null});};
  try{
    const client=new QueueClient({provider:'cloudflare',origin:'https://rail-test.example.workers.dev',deviceId:'synthetic-device',deviceName:'test',deviceToken:'synthetic-device-token',serviceToken:'stale-synthetic-sites-token'});
    await client.claim();
    assert.equal(requests[0].url,'https://rail-test.example.workers.dev/api/helper/claim');
    assert.equal(requests[0].headers.get('authorization'),'Bearer synthetic-device-token');
    assert.equal(requests[0].headers.get('oai-sites-authorization'),null);
    assert.equal(requests[0].redirect,'error');
  }finally{globalThis.fetch=original;}
});

test('Sites 同时保留平台服务和设备授权，旧配置仍按 Sites 处理',async()=>{
  const original=globalThis.fetch;let headers:Headers|undefined;
  globalThis.fetch=async(_input,init)=>{headers=new Headers(init?.headers);return Response.json({job:null});};
  try{
    const legacy={origin:'https://synthetic.chatgpt.site',deviceId:'synthetic-device',deviceName:'test',deviceToken:'synthetic-device-token',serviceToken:'synthetic-sites-token'};
    await new QueueClient(legacy as ConstructorParameters<typeof QueueClient>[0]).claim();
    assert.equal(headers?.get('authorization'),'Bearer synthetic-device-token');
    assert.equal(headers?.get('oai-sites-authorization'),'Bearer synthetic-sites-token');
  }finally{globalThis.fetch=original;}
});

test('未配对设备不能读取或领取任务，Cloudflare 401 提示重新配对',async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{requests++;return new Response('Unauthorized',{status:401});};
  try{
    const config={provider:'cloudflare' as const,origin:'https://rail-test.example.workers.dev',deviceId:'synthetic-device',deviceName:'test',deviceToken:'',serviceToken:''};
    await assert.rejects(new QueueClient(config).claim(),/设备尚未配对/);assert.equal(requests,0);
    await assert.rejects(new QueueClient({...config,deviceToken:'synthetic-device-token'}).health(),error=>error instanceof Error&&error.message.includes('HTTP 401')&&error.message.includes('重新配对')&&!error.message.includes('Sites'));
    assert.equal(requests,1);
  }finally{globalThis.fetch=original;}
});

test('进度和最终结果使用相同快照格式，保留租约；UTF-8 超容量在发出请求前拒绝',async()=>{
  const original=globalThis.fetch;
  const updates:Record<string,unknown>[]=[];
  globalThis.fetch=async(_input,init)=>{updates.push(JSON.parse(String(init?.body)));return Response.json({ok:true});};
  try{
    const client=new QueueClient({provider:'cloudflare',origin:'https://rail-test.example.workers.dev',deviceId:'synthetic-device',deviceName:'test',deviceToken:'synthetic-device-token',serviceToken:''});
    const result:SearchResult={plans:[],observations:[],complete:false,issues:['当前区间未知'],completedAt:null};
    const job={id:'test-job',version:7} as RailJob;
    await client.progress(job,'synthetic-lease','running','progress',result);
    await client.result(job,'synthetic-lease','partial','done',result);
    for(const update of updates){
      assert.equal(update.version,7);assert.equal(update.leaseToken,'synthetic-lease');
      assert.deepEqual(unpackResult(update.result as Parameters<typeof unpackResult>[0]),result);
    }
    await assert.rejects(client.result(job,'synthetic-lease','partial','large',{...result,issues:['中'.repeat(660_000)]}),/上传容量/);
    assert.equal(updates.length,2);
  }finally{globalThis.fetch=original;}
});
test('同一进程稳定发送会话身份、读取本人恢复版本且正常释放',async()=>{
 const original=globalThis.fetch,ids:string[]=[];
 globalThis.fetch=async(input,init)=>{ids.push(new Headers(init?.headers).get('X-Rail-Runner-Id')||'');return Response.json(String(input).endsWith('/status')?{cancelled:false,resumeVersion:7}:{job:null,resumeVersion:3});};
 try{
  const client=new QueueClient({provider:'cloudflare',origin:'https://rail-test.example',deviceId:'fixture',deviceName:'test',deviceToken:'synthetic-device-token',serviceToken:''});
  await client.claim();assert.equal(client.resumeVersion(),3);await client.status({id:'job',version:1} as RailJob,'lease');assert.equal(client.resumeVersion(),7);await client.release();
  assert.equal(new Set(ids).size,1);assert.match(ids[0],/^[0-9a-f-]{36}$/);
 }finally{globalThis.fetch=original;}
});
test('停止取消在途请求，但随后释放会话仍能发出新请求',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async(_input,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
 try{
  const client=new QueueClient({provider:'cloudflare',origin:'https://rail-test.example',deviceId:'fixture',deviceName:'test',deviceToken:'synthetic-device-token',serviceToken:''});
  const pending=client.claim();client.cancelPending();await assert.rejects(pending,/Aborted/);
  globalThis.fetch=async()=>Response.json({ok:true});await client.release();
 }finally{globalThis.fetch=original;}
});
