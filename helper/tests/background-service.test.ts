import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireProcessLock,inheritedProxyEnvironment,launchAgentPlist,resumeLocalUser,runningPid,validResume,waitForLocalUser} from '../src/background-service.ts';

async function fixture(){const directory=await mkdtemp(join(tmpdir(),'rail-helper-test-'));return {directory,dispose:()=>rm(directory,{recursive:true,force:true})};}
async function waitingFile(directory:string){for(let i=0;i<100;i++){try{return JSON.parse(await readFile(join(directory,'waiting.json'),'utf8')) as {requestId:string;jobId:string;pid:number};}catch{await new Promise(resolve=>setTimeout(resolve,5));}}throw new Error('No waiting request was written');}

test('后台服务直接运行已配置 Node 和 TypeScript，不依赖 shell、终端或 PATH',()=>{
  const plist=launchAgentPlist({nodePath:'/Node & Runtime/node',helperPath:'/Project <rail> helper',runtimePath:'/Private "runtime"'});
  assert.match(plist,/<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist,/<key>KeepAlive<\/key><true\/>/);
  assert.match(plist,/<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(plist,/<string>\/Node &amp; Runtime\/node<\/string>/);
  assert.match(plist,/<string>\/Project &lt;rail&gt; helper\/node_modules\/tsx\/dist\/loader.mjs<\/string>/);
  assert.match(plist,/<string>--background<\/string>/);
  assert.doesNotMatch(plist,/\/bin\/(?:ba)?sh|--prevent-idle-sleep/);
  assert.match(launchAgentPlist({nodePath:'/node',helperPath:'/helper',runtimePath:'/runtime',preventIdleSleep:true}),/<string>--prevent-idle-sleep<\/string>/);
});

test('后台服务仅继承明确的代理变量，不把其他环境凭据写入 plist',()=>{
  const environment={NODE_USE_ENV_PROXY:'1',HTTP_PROXY:'http://127.0.0.1:1082',HTTPS_PROXY:'http://127.0.0.1:1082',NO_PROXY:'localhost,127.0.0.1,::1',PRIVATE_TOKEN:'synthetic-secret-never-saved',PATH:'/private/path'};
  assert.deepEqual(inheritedProxyEnvironment(environment),{NODE_USE_ENV_PROXY:'1',HTTP_PROXY:'http://127.0.0.1:1082',HTTPS_PROXY:'http://127.0.0.1:1082',NO_PROXY:'localhost,127.0.0.1,::1'});
  const plist=launchAgentPlist({nodePath:'/node',helperPath:'/helper',runtimePath:'/runtime',environment});
  assert.match(plist,/<key>EnvironmentVariables<\/key><dict>/);
  assert.match(plist,/<key>NODE_USE_ENV_PROXY<\/key><string>1<\/string>/);
  assert.match(plist,/<key>HTTPS_PROXY<\/key><string>http:\/\/127\.0\.0\.1:1082<\/string>/);
  assert.doesNotMatch(plist,/PRIVATE_TOKEN|synthetic-secret-never-saved|\/private\/path/);
  assert.doesNotMatch(launchAgentPlist({nodePath:'/node',helperPath:'/helper',runtimePath:'/runtime'}),/EnvironmentVariables/);
});

test('代理 URL 中的账号密码不会进入后台 plist 或错误消息',()=>{
  for(const value of ['http://synthetic-user:synthetic-password@proxy.example:8080','https://synthetic-user@proxy.example','file:///private/proxy','http://proxy.example/secret?token=synthetic-secret']){
    assert.throws(()=>inheritedProxyEnvironment({HTTPS_PROXY:value}),error=>error instanceof Error&&!error.message.includes('synthetic-user')&&!error.message.includes('synthetic-password')&&!error.message.includes('synthetic-secret'));
  }
  assert.throws(()=>inheritedProxyEnvironment({NODE_USE_ENV_PROXY:'yes'}),/只能设为/);
  assert.throws(()=>inheritedProxyEnvironment({NO_PROXY:'localhost\nPASSWORD=synthetic-secret'}),/格式无效/);
});

test('无终端的验证等待可由本机命令恢复，文件限制为本人可读且完成后清理',async()=>{
  const f=await fixture();const controller=new AbortController();let notified='';
  try{
    await writeFile(join(f.directory,'helper.pid'),String(process.pid));
    const wait=waitForLocalUser({jobId:'test-job',message:'请在官网本人完成验证',signal:controller.signal,resumeVersion:()=>0,directory:f.directory,interactive:false,pollMs:5,notify:async message=>{notified=message;}});
    const waiting=await waitingFile(f.directory);assert.equal(waiting.jobId,'test-job');assert.equal(waiting.pid,process.pid);
    assert.equal((await stat(join(f.directory,'waiting.json'))).mode&0o777,0o600);
    assert.match(await resumeLocalUser(f.directory),/已通知助手恢复/);await wait;
    assert.match(notified,/本人/);
    await assert.rejects(readFile(join(f.directory,'waiting.json')),/ENOENT/);
    await assert.rejects(readFile(join(f.directory,'resume.json')),/ENOENT/);
  }finally{controller.abort();await f.dispose();}
});

test('旧网页恢复版本和旧本机恢复文件不会误恢复新的验证请求',async()=>{
  const f=await fixture();const controller=new AbortController();let version=5,finished=false;
  try{
    await writeFile(join(f.directory,'resume.json'),JSON.stringify({requestId:'old-request'}));
    const wait=waitForLocalUser({jobId:'test-job',message:'验证',signal:controller.signal,resumeVersion:()=>version,directory:f.directory,interactive:false,pollMs:5,notify:async()=>{}}).then(()=>{finished=true;});
    const waiting=await waitingFile(f.directory);
    await writeFile(join(f.directory,'resume.json'),JSON.stringify({requestId:'other-request'}));
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(finished,false);
    assert.equal(validResume(waiting,{requestId:'other-request'}),false);
    version=6;await wait;assert.equal(finished,true);
  }finally{controller.abort();await f.dispose();}
});

test('等待官网验证时取消任务立即结束，并清理本机恢复指令',async()=>{
  const f=await fixture();const controller=new AbortController();
  try{
    const wait=waitForLocalUser({jobId:'test-job',message:'验证',signal:controller.signal,resumeVersion:()=>0,directory:f.directory,interactive:false,pollMs:60_000,notify:async()=>{}});
    const rejected=assert.rejects(wait,error=>error instanceof Error&&error.name==='AbortError');
    await waitingFile(f.directory);controller.abort();await rejected;
    await assert.rejects(readFile(join(f.directory,'waiting.json')),/ENOENT/);
    await assert.rejects(resumeLocalUser(f.directory),/没有等待/);
  }finally{controller.abort();await f.dispose();}
});

test('网页迅速确认验证后，本机等待使用发布提示前的版本并立即恢复',async()=>{
  const f=await fixture();const controller=new AbortController();
  try{
    await waitForLocalUser({jobId:'test-job',message:'验证',signal:controller.signal,resumeVersion:()=>11,initialResumeVersion:10,directory:f.directory,interactive:false,pollMs:60_000,notify:async()=>{}});
    await assert.rejects(readFile(join(f.directory,'waiting.json')),/ENOENT/);
  }finally{controller.abort();await f.dispose();}
});

test('专用浏览器的本机进程锁拒绝并发助手，退出后允许新助手', {skip:process.platform!=='darwin'},async()=>{
  const f=await fixture();let unlock:(()=>Promise<void>)|undefined;
  try{
    unlock=await acquireProcessLock(f.directory);assert.equal(await runningPid(f.directory),process.pid);
    await assert.rejects(acquireProcessLock(f.directory),/已有查询助手/);
    await unlock();unlock=undefined;assert.equal(await runningPid(f.directory),undefined);
    unlock=await acquireProcessLock(f.directory);
  }finally{await unlock?.();await f.dispose();}
});
