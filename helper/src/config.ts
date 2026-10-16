import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline/promises';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
const exec=promisify(execFile);
const ACCOUNT='rail-assistant';
const service=(key:string)=>`cn.rail-assistant.${key}`;
export type Provider='sites'|'cloudflare';
export type Config={provider:Provider;origin:string;deviceId:string;deviceName:string;deviceToken:string;serviceToken:string};
async function read(key:string){try{return (await exec('/usr/bin/security',['find-generic-password','-a',ACCOUNT,'-s',service(key),'-w'],{maxBuffer:64*1024})).stdout.trim();}catch{return '';}}
async function write(key:string,value:string){
  // security interactive mode keeps secret values out of process arguments and shell history.
  const quote=(s:string)=>`"${s.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`;
  await new Promise<void>((resolve,reject)=>{
    const child=spawn('/usr/bin/security',['-i'],{stdio:['pipe','ignore','pipe']});let stderr='';
    child.stderr.on('data',data=>{stderr+=String(data);});
    child.on('error',()=>reject(new Error('无法访问 macOS 钥匙串')));
    child.on('close',code=>{if(code===0&&!/error|failed/i.test(stderr))resolve();else reject(new Error('钥匙串保存失败，请检查 macOS 提示后重试'));});
    child.stdin.end(`add-generic-password -U -a ${quote(ACCOUNT)} -s ${quote(service(key))} -w ${quote(value)}\n`);
  });
}
export function validatedOrigin(input:string):string{
  const u=new URL(input);if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('请只输入网站 origin，例如 https://xxx.workers.dev');
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw new Error('远程网站必须使用 HTTPS');
  return u.origin;
}
export function isLocal(origin:string){return ['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname);}
export function validatedProvider(input:unknown):Provider{
  // Existing Keychain records and stdin installers predate the provider field.
  if(input===undefined||input===null||input==='')return 'sites';
  if(input!=='sites'&&input!=='cloudflare')throw new Error('云端类型必须是 sites 或 cloudflare');
  return input;
}
export function normalizedConfig(input:Partial<Config>,options:{allowUnpaired?:boolean;stored?:boolean}={}):Config{
  const provider=validatedProvider(input.provider);
  if(typeof input.origin!=='string'||!input.origin)throw new Error('网站 origin 缺失');
  const origin=validatedOrigin(input.origin);
  const deviceToken=typeof input.deviceToken==='string'?input.deviceToken.trim():'';
  let serviceToken=typeof input.serviceToken==='string'?input.serviceToken.trim():'';
  if(!deviceToken&&!options.allowUnpaired)throw new Error('尚未配置设备令牌，请先运行 setup.command 完成网页配对');
  if(deviceToken&&!/^[A-Za-z0-9_-]{20,500}$/.test(deviceToken))throw new Error('设备令牌格式无效');
  if(/[\r\n]/.test(serviceToken))throw new Error('服务凭据格式无效');
  if(provider==='cloudflare'){
    if(serviceToken&&!options.stored)throw new Error('Cloudflare 配置不接受 Sites 服务凭据');
    // Even a stale Keychain value must never leave the machine for a new host.
    serviceToken='';
  }else if(!isLocal(origin)&&!serviceToken)throw new Error('私有 Site 尚未配置服务凭据，请通过 Sites 工具完成配置');
  return {provider,origin,deviceToken,serviceToken,deviceId:input.deviceId||randomUUID(),deviceName:input.deviceName||hostname()};
}
export async function loadConfig(options:{allowUnpaired?:boolean}={}):Promise<Config>{
  if(process.platform!=='darwin')throw new Error('此助手使用 macOS 钥匙串，请在 Mac 上运行');
  const [origin,deviceToken,serviceToken,id,provider]=await Promise.all(['origin','deviceToken','serviceToken','deviceId','provider'].map(read));
  if(!origin||(!deviceToken&&!options.allowUnpaired))throw new Error('尚未配置助手，请先运行 setup.command');
  return normalizedConfig({origin,deviceToken,serviceToken,deviceId:id,provider:validatedProvider(provider)}, {...options,stored:true});
}
async function clearChangedBinding(origin:string,provider:Provider){
  const [priorOrigin,priorProvider]=await Promise.all([read('origin'),read('provider')]);
  if(priorOrigin!==origin||validatedProvider(priorProvider)!==provider){
    // Remove both credentials before changing either part of the destination.
    await write('deviceToken','');await write('serviceToken','');await write('deviceId',randomUUID());
  }
}
async function saveConfig(config:Config){
  await clearChangedBinding(config.origin,config.provider);
  await write('origin',config.origin);await write('provider',config.provider);
  await write('serviceToken',config.serviceToken);await write('deviceToken',config.deviceToken);await write('deviceId',config.deviceId);
}
export async function setupConfig(){
  if(process.platform!=='darwin')throw new Error('请在 macOS 上配置钥匙串');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{
    const [current,currentProviderValue]=await Promise.all([read('origin'),read('provider')]);
    const currentProvider=current?validatedProvider(currentProviderValue):'cloudflare';
    const provider=validatedProvider((await rl.question(`云端类型 sites / cloudflare [${currentProvider}]：`)).trim()||currentProvider);
    const defaultOrigin=current||'https://rail-same-train-pages.pages.dev';
    const origin=validatedOrigin((await rl.question(`网站 origin [${defaultOrigin}]：`)).trim()||defaultOrigin);
    rl.close();
    const token=(await hiddenQuestion('粘贴网页生成的设备令牌（输入隐藏）：')).trim();
    if(!/^[A-Za-z0-9_-]{20,500}$/.test(token))throw new Error('设备令牌格式无效');
    let serviceToken='';
    if(provider==='sites'&&!isLocal(origin)){
      serviceToken=origin===current&&provider===currentProvider?await read('serviceToken'):'';
      if(!serviceToken)serviceToken=(await hiddenQuestion('粘贴 Sites 工具配置的服务凭据（输入隐藏）：')).trim();
      if(!serviceToken||/[\r\n]/.test(serviceToken))throw new Error('服务凭据不能为空');
    }
    await saveConfig(normalizedConfig({provider,origin,deviceToken:token,serviceToken}));
    console.log('已存入 macOS 钥匙串。账号、Cookie 和服务凭据不会写入项目文件。');
  }finally{rl.close();}
}
async function hiddenQuestion(prompt:string):Promise<string>{
  if(!process.stdin.isTTY)throw new Error('请在电脑终端中交互配置凭据');
  process.stdout.write(prompt);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{let value='';const cleanup=()=>{process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdout.write('\n');};
    const onData=(chunk:Buffer)=>{for(const c of chunk.toString('utf8')){if(c==='\u0003'){cleanup();reject(new Error('已取消配置'));return;}if(c==='\r'||c==='\n'){cleanup();resolve(value);return;}if(c==='\u007f'){value=value.slice(0,-1);}else if(c>=' '){value+=c;}}};process.stdin.on('data',onData);
  });
}
// Used by authenticated installation tooling: never prints values, accepts only fixed fields.
export async function setupFromStdin(){
  let data='';for await(const chunk of process.stdin){data+=String(chunk);if(data.length>32_000)throw new Error('配置输入过长');}
  const v=JSON.parse(data) as Partial<Config>;
  if(!v.origin||!v.deviceToken)throw new Error('配置字段缺失');
  await saveConfig(normalizedConfig(v));
  console.log('助手配置已安全保存到 macOS 钥匙串。');
}
export async function setupSiteFromStdin(){
  let data='';for await(const chunk of process.stdin){data+=String(chunk);if(data.length>32_000)throw new Error('配置输入过长');}
  const v=JSON.parse(data) as Partial<Config>;if(!v.origin)throw new Error('站点 origin 缺失');
  const config=normalizedConfig(v,{allowUnpaired:true});
  await clearChangedBinding(config.origin,config.provider);
  await write('origin',config.origin);await write('provider',config.provider);await write('serviceToken',config.serviceToken);
  console.log('网站与云端类型已存入 macOS 钥匙串；设备令牌需在网页配对。');
}
