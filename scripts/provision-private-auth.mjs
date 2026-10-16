import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pbkdf2Sync,randomBytes,randomUUID} from 'node:crypto';
import {readDeploymentConfig} from './deployment-config.mjs';
const {configPath}=readDeploymentConfig('private');
const exec=promisify(execFile);
const account='rail-assistant';
const service=key=>`cn.rail-assistant.${key}`;
if(process.platform!=='darwin')throw new Error('此安装脚本使用 macOS 钥匙串，请在 Mac 上运行。');
async function read(key){
  try{return (await exec('/usr/bin/security',['find-generic-password','-a',account,'-s',service(key),'-w'])).stdout.trim();}
  catch(error){
    if(error.code===44||/The specified item could not be found in the keychain/i.test(error.stderr||''))return '';
    throw new Error('无法读取 macOS 钥匙串，请解锁或允许访问后重试；现有网页登录凭据未更换。');
  }
}
async function write(key,value){
  const quote=s=>`"${s.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`;
  await new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/security',['-i'],{stdio:['pipe','ignore','pipe']});let error='';
    child.stderr.on('data',chunk=>{error+=String(chunk)});
    child.on('error',reject);child.on('close',code=>code===0&&!/error|failed/i.test(error)?resolve():reject(new Error('钥匙串保存失败')));
    child.stdin.end(`add-generic-password -U -a ${quote(account)} -s ${quote(service(key))} -w ${quote(value)}\n`);
  });
}
const wrangler=new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url).pathname;
const auth=await exec(process.execPath,[wrangler,'whoami']);
if(/not authenticated|not logged in/i.test(auth.stdout+auth.stderr))throw new Error('Cloudflare 尚未授权，请先运行 npx wrangler login。');
const prior=await Promise.all(['webPassword','webOwnerId','webSessionSecret'].map(read));
if(prior.some(Boolean)&&!prior.every(Boolean))throw new Error('已有网页登录凭据不完整，请修复钥匙串后重试，避免更换网站拥有者。');
const password=prior[0]||randomBytes(24).toString('base64url');
const owner=prior[1]||randomUUID();
const sessionSecret=prior[2]||randomBytes(48).toString('base64url');
if(!/^[A-Za-z0-9_-]{6,128}$/.test(password)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner)||!/^[A-Za-z0-9_-]{32,128}$/.test(sessionSecret))throw new Error('已有网页登录凭据格式无效，请检查钥匙串；凭据未更换。');
await write('webPassword',password);await write('webOwnerId',owner);await write('webSessionSecret',sessionSecret);
const salt=randomBytes(16).toString('hex');
const passwordHash=`pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`;
const secrets={RAIL_PASSWORD_HASH:passwordHash,RAIL_OWNER_ID:owner,RAIL_SESSION_SECRET:sessionSecret};
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[wrangler,'secret','bulk','--config',configPath],{stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',chunk=>{process.stdout.write(chunk)});child.stderr.on('data',chunk=>{process.stderr.write(chunk)});
  child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Cloudflare 私人登录配置未完成')));
  child.stdin.end(JSON.stringify(secrets));
});
console.log('私人登录已配置。网页登录口令保存在 Mac 钥匙串 cn.rail-assistant.webPassword；不会写入代码或安装包。');
