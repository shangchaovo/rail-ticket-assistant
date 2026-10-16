import {spawnSync} from 'node:child_process';
import {readDeploymentConfig} from './deployment-config.mjs';
const {configPath,config}=readDeploymentConfig('private');
const wrangler=new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url).pathname;
function run(args,options={}){
  const result=spawnSync(process.execPath,args,{stdio:'inherit',...options});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
const auth=spawnSync(process.execPath,[wrangler,'whoami'],{encoding:'utf8'});
if(auth.status!==0||/not authenticated|not logged in/i.test(auth.stdout+auth.stderr)){
  console.error('请先运行 npx wrangler login，完成 Cloudflare 账号授权。');process.exit(1);
}
if(!config.account_id||config.d1_databases.some(db=>db.database_id==='00000000-0000-4000-8000-000000000000')){
  console.error('请先在 wrangler.cloudflare.local.json 填入 Cloudflare 账户和实际 D1 数据库 ID。');process.exit(1);
}
run(['scripts/run-framework.mjs','build'],{env:{...process.env,RAIL_DEPLOY_TARGET:'cloudflare'}});
run([wrangler,'d1','migrations','apply','rail-same-train','--config',configPath,'--remote'],{env:{...process.env,CI:'true'}});
run([wrangler,'deploy','--config','dist/server/wrangler.json']);
console.log('网页代码已部署。首次部署后请运行 node scripts/provision-private-auth.mjs 配置私人登录。');
