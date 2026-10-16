import {spawnSync} from 'node:child_process';
import {readDeploymentConfig} from './deployment-config.mjs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const {configPath,config}=readDeploymentConfig('public');
const {config:pages}=readDeploymentConfig('pages');
if(config.name!=='rail-query-public'||!config.account_id||config.d1_databases?.some(db=>db.database_id==='00000000-0000-4000-8000-000000000000')||config.d1_databases?.length!==1||config.d1_databases[0].binding!=='PUBLIC_DB'||config.d1_databases[0].database_name!=='rail-query-public')throw new Error('公开查询必须使用独立的 Public D1 绑定');
if(!pages.services?.some(service=>service.binding==='PUBLIC_BACKEND'&&service.service===config.name))throw new Error('Pages 的公开服务绑定不匹配');
const wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const options={cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_ACCOUNT_ID:config.account_id}};
function run(args,capture=false){
 const result=spawnSync(process.execPath,args,{...options,...(capture?{encoding:'utf8'}:{stdio:'inherit'})});
 if(result.error)throw result.error;
 if(result.status!==0)throw new Error(`执行失败：${args[0]}`);
 return capture?result.stdout:'';
}
const auth=run([wrangler,'whoami'],true);
if(/not authenticated|not logged in/i.test(auth))throw new Error('请先使用 wrangler login 完成 Cloudflare 授权');
const secrets=JSON.parse(run([wrangler,'secret','list','--config',configPath],true));
if(!secrets.some(secret=>secret.name==='RATE_SALT'))throw new Error('请先通过 stdin 配置 RATE_SALT secret，不要将其写入源码');
run([fileURLToPath(new URL('./build-public-cloud.mjs',import.meta.url))]);
run([wrangler,'d1','execute','rail-query-public','--remote','--config',configPath,'--file','cloud/public/schema.sql']);
run([wrangler,'deploy','--config',configPath]);
console.log('公开查询 Worker 已发布；验收后单独执行 npm run deploy:pages 切换正式入口。');
