import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {access,chmod,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';

const exec=promisify(execFile);
export const SERVICE_LABEL='cn.rail-assistant.helper';
export const HELPER_HOME=join(homedir(),'Library','Application Support','12306 Rail Assistant');
export const RUNTIME_HOME=join(HELPER_HOME,'runtime');
export const HELPER_PATH=fileURLToPath(new URL('..',import.meta.url));
export const SERVICE_PLIST=join(homedir(),'Library','LaunchAgents',`${SERVICE_LABEL}.plist`);
type WaitingRequest={requestId:string;jobId:string;message:string;createdAt:string;pid:number};
type ResumeRequest={requestId:string};
const lockPath=(directory:string)=>join(directory,'helper.pid');
const waitingPath=(directory:string)=>join(directory,'waiting.json');
const resumePath=(directory:string)=>join(directory,'resume.json');
export const isProcessAlive=(pid:number)=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}};
async function readJson<T>(path:string):Promise<T|undefined>{try{return JSON.parse(await readFile(path,'utf8')) as T;}catch{return undefined;}}
async function privateDirectory(directory:string){await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);}
async function atomicJson(path:string,value:unknown){const temporary=`${path}.${randomUUID()}.tmp`;try{await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,path);}finally{await rm(temporary,{force:true});}}
export async function runningPid(directory=RUNTIME_HOME):Promise<number|undefined>{
  try{const pid=Number((await readFile(lockPath(directory),'utf8')).trim());return isProcessAlive(pid)?pid:undefined;}catch{return undefined;}
}
// shlock atomically links a PID lock, verifies live owners and reclaims a dead
// process after a crash. Every helper checkout shares the same profile lock.
export async function acquireProcessLock(directory=RUNTIME_HOME){
  if(process.platform!=='darwin')throw new Error('后台助手与专用浏览器进程锁需要 macOS');
  await privateDirectory(directory);
  try{await exec('/usr/bin/shlock',['-f',lockPath(directory),'-p',String(process.pid)]);}catch{throw new Error('这台 Mac 已有查询助手在使用专用浏览器。请先停止旧助手；后台状态可用 npm run service:status 查看。');}
  await chmod(lockPath(directory),0o600);
  return async()=>{if(await runningPid(directory)===process.pid)await rm(lockPath(directory),{force:true});};
}
export async function notifyMac(message:string,title='同车余票'){
  if(process.platform!=='darwin')return;
  // Pass notification text as arguments; neither a shell nor AppleScript code
  // receives interpolated user content, station names or credentials.
  await exec('/usr/bin/osascript',['-e','on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv)\nend run',message.slice(0,500),title.slice(0,80)],{timeout:10_000,maxBuffer:1024}).catch(()=>{});
}
export function preventIdleSleep():ChildProcess|undefined{
  if(process.platform!=='darwin')return;
  const child=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});
  child.on('error',()=>{});return child;
}
export function validResume(waiting:{requestId:string}|undefined,resume:ResumeRequest|undefined){return !!waiting&&!!resume&&typeof waiting.requestId==='string'&&waiting.requestId===resume.requestId;}
function abortError(){return new DOMException('助手已停止或任务已取消','AbortError');}
export async function waitForLocalUser(options:{jobId:string;message:string;signal:AbortSignal;resumeVersion:()=>number;initialResumeVersion?:number;directory?:string;interactive?:boolean;notify?:(message:string)=>Promise<void>;pollMs?:number}){
  const directory=options.directory||RUNTIME_HOME;
  if(options.signal.aborted)throw abortError();
  // The CLI captures this before publishing waiting_user, because the owner
  // can acknowledge in the webpage before local state finishes writing.
  const initialVersion=options.initialResumeVersion??options.resumeVersion();
  await privateDirectory(directory);
  const waiting:WaitingRequest={requestId:randomUUID(),jobId:options.jobId,message:options.message.slice(0,1000),createdAt:new Date().toISOString(),pid:process.pid};
  await rm(resumePath(directory),{force:true});await atomicJson(waitingPath(directory),waiting);
  let rl:ReturnType<typeof createInterface>|undefined;
  let entered=false;
  const stopInput=new AbortController();
  try{
    if(options.interactive??process.stdin.isTTY){
      rl=createInterface({input:process.stdin,output:process.stdout});
      void rl.question('在官方浏览器处理完成后按 Enter，或在网页点“已处理，恢复助手”：',{signal:stopInput.signal}).then(()=>{entered=true;}).catch(()=>{});
    }
    // Notification delivery is best effort; it must never block cancellation
    // or lose an otherwise valid waiting task.
    void (options.notify||notifyMac)(`${options.message}\n本人处理后在网页恢复，或运行 npm run resume。`).catch(()=>{});
    while(true){
      if(options.signal.aborted)throw abortError();
      if(entered||options.resumeVersion()>initialVersion||validResume(waiting,await readJson<ResumeRequest>(resumePath(directory))))return;
      await new Promise<void>((resolve,reject)=>{
        const onAbort=()=>{clearTimeout(timer);options.signal.removeEventListener('abort',onAbort);reject(abortError());};
        const timer=setTimeout(()=>{options.signal.removeEventListener('abort',onAbort);resolve();},options.pollMs??1000);
        options.signal.addEventListener('abort',onAbort,{once:true});
        if(options.signal.aborted)onAbort();
      });
    }
  }finally{
    stopInput.abort();rl?.close();
    if((await readJson<WaitingRequest>(waitingPath(directory)))?.requestId===waiting.requestId){await rm(waitingPath(directory),{force:true});await rm(resumePath(directory),{force:true});}
  }
}
export async function resumeLocalUser(directory=RUNTIME_HOME){
  const waiting=await readJson<WaitingRequest>(waitingPath(directory));
  if(!waiting||!isProcessAlive(waiting.pid)||await runningPid(directory)!==waiting.pid)throw new Error('助手当前没有等待本人处理的任务。请用 npm run service:status 查看状态。');
  await atomicJson(resumePath(directory),{requestId:waiting.requestId});
  return '已通知助手恢复。本次受验证影响的查询会保留已确认结果；需要新库存时请重新查询。';
}
const xml=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function inheritedProxyEnvironment(environment:NodeJS.ProcessEnv):Record<string,string>{
  const result:Record<string,string>={};
  const useProxy=environment.NODE_USE_ENV_PROXY?.trim();
  if(useProxy){if(!['0','1'].includes(useProxy))throw new Error('NODE_USE_ENV_PROXY 只能设为 0 或 1');result.NODE_USE_ENV_PROXY=useProxy;}
  for(const name of ['HTTP_PROXY','HTTPS_PROXY'] as const){
    const value=environment[name]?.trim();if(!value)continue;
    let url:URL;try{url=new URL(value);}catch{throw new Error('代理地址格式无效；请使用不含账号密码的 HTTP/HTTPS origin');}
    if(value.length>1000||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||/[\r\n]/.test(value))throw new Error('后台代理地址必须是无账号密码的 HTTP/HTTPS origin；含凭据的地址不会写入 plist');
    result[name]=url.origin;
  }
  const noProxy=environment.NO_PROXY?.trim();
  if(noProxy){if(noProxy.length>2000||!/^[A-Za-z0-9._:*\[\],/ -]+$/.test(noProxy))throw new Error('NO_PROXY 格式无效；请只填写主机、端口或网段列表');result.NO_PROXY=noProxy;}
  return result;
}
export function launchAgentPlist(options:{nodePath:string;helperPath:string;runtimePath:string;preventIdleSleep?:boolean;environment?:NodeJS.ProcessEnv}){
  const args=[options.nodePath,'--import',join(options.helperPath,'node_modules','tsx','dist','loader.mjs'),join(options.helperPath,'src','cli.ts'),'start','--background',...(options.preventIdleSleep?['--prevent-idle-sleep']:[])];
  const environment=inheritedProxyEnvironment(options.environment??{});
  const envXml=Object.keys(environment).length?`<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key,value])=>`<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>\n`:'';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${SERVICE_LABEL}</string>\n${envXml}<key>ProgramArguments</key><array>${args.map(value=>`<string>${xml(value)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(options.helperPath)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>ExitTimeOut</key><integer>30</integer>\n<key>ProcessType</key><string>Background</string>\n<key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(join(options.runtimePath,'helper.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(options.runtimePath,'helper-error.log'))}</string>\n</dict></plist>\n`;
}
function serviceTarget(){if(process.platform!=='darwin'||!process.getuid)throw new Error('后台服务只支持 macOS 当前登录用户');return `gui/${process.getuid()}`;}
async function registered(){try{await exec('/bin/launchctl',['print',`${serviceTarget()}/${SERVICE_LABEL}`],{maxBuffer:1024*1024});return true;}catch{return false;}}
export async function installService(options:{preventIdleSleep?:boolean}={}){
  serviceTarget();await access(join(HELPER_PATH,'node_modules','tsx','dist','loader.mjs'));
  if(await runningPid())throw new Error('请先停止当前助手，再安装后台服务；后台助手用 npm run service:stop，前台助手用 Control+C。');
  if(await registered())await stopService();
  await privateDirectory(RUNTIME_HOME);await mkdir(dirname(SERVICE_PLIST),{recursive:true});
  for(const name of ['helper.log','helper-error.log']){const path=join(RUNTIME_HOME,name);await writeFile(path,'',{flag:'a',mode:0o600});await chmod(path,0o600);}
  await writeFile(SERVICE_PLIST,launchAgentPlist({nodePath:process.execPath,helperPath:HELPER_PATH,runtimePath:RUNTIME_HOME,environment:process.env,...options}),{mode:0o600});
  await startService();
  return `后台服务已安装并启动。登录此 macOS 账号后自动运行；日志：${join(RUNTIME_HOME,'helper.log')}`;
}
export async function startService(){
  await access(SERVICE_PLIST).catch(()=>{throw new Error('尚未安装后台服务，请运行 npm run service:install。');});
  const target=serviceTarget();
  if(await registered())return '后台服务已注册；运行状态请用 npm run service:status 查看。';
  if(await runningPid())throw new Error('已有前台助手正在运行，请先用 Control+C 停止。');
  try{await exec('/bin/launchctl',['enable',`${target}/${SERVICE_LABEL}`]);await exec('/bin/launchctl',['bootstrap',target,SERVICE_PLIST]);}
  catch{throw new Error(`后台服务启动失败，请查看 ${join(RUNTIME_HOME,'helper-error.log')}；确认当前用户已登录桌面，项目与 Node 路径没有移动。`);}
  return '后台服务已启动；关闭终端后仍可工作。';
}
export async function stopService(){
  const target=serviceTarget();const loaded=await registered();
  if(loaded)await exec('/bin/launchctl',['bootout',`${target}/${SERVICE_LABEL}`]);
  // Disable the saved LaunchAgent too: a requested stop must survive a new
  // login. service:start explicitly re-enables it before bootstrapping.
  await exec('/bin/launchctl',['disable',`${target}/${SERVICE_LABEL}`]);
  if(loaded){
    const deadline=Date.now()+35_000;
    while(await runningPid()){if(Date.now()>=deadline)throw new Error('后台服务已停用，但旧进程仍未退出。请运行 npm run service:status 查看后再启动。');await new Promise(resolve=>setTimeout(resolve,250));}
  }
  return '后台服务已停止，不会在下次登录时自动启动；npm run service:start 可重新启用。';
}
export async function uninstallService(){await stopService();await rm(SERVICE_PLIST,{force:true});return '后台服务已卸载。钥匙串配对和官方浏览器会话仍保存在本机。';}
export async function serviceStatus(){
  const pid=await runningPid();const waiting=await readJson<WaitingRequest>(waitingPath(RUNTIME_HOME));
  let installed=false;try{await access(SERVICE_PLIST);installed=true;}catch{}
  const loaded=process.platform==='darwin'?await registered():false;
  return {installed,registered:loaded,running:!!pid,pid:pid??null,waiting:pid&&waiting?.pid===pid?{message:waiting.message,createdAt:waiting.createdAt}:null,log:join(RUNTIME_HOME,'helper.log'),errorLog:join(RUNTIME_HOME,'helper-error.log'),notice:'电脑休眠、关机、注销或断网时无法查询；后台服务只在此用户登录且电脑保持联网时运行。'};
}
