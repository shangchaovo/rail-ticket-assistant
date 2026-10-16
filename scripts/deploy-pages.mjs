import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {readDeploymentConfig} from './deployment-config.mjs';
import {preparePagesDeployment} from './prepare-pages-deployment.mjs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const pages=fileURLToPath(new URL('../cloudflare-pages/',import.meta.url));
const {config}=readDeploymentConfig('pages');
const {config:backend}=readDeploymentConfig('private');
if(config.name!=='rail-same-train-pages'||config.services?.[0]?.service!==backend.name||!backend.account_id)throw new Error('Pages 与已部署的私人 Worker 绑定不匹配');
const wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const options={env:{...process.env,CLOUDFLARE_ACCOUNT_ID:backend.account_id}};
const auth=spawnSync(process.execPath,[wrangler,'whoami'],{...options,cwd:root,encoding:'utf8'});
if(auth.status!==0||/not authenticated|not logged in/i.test(auth.stdout+auth.stderr))throw new Error('请先运行 npx wrangler login 完成 Cloudflare 授权');
// Pages requires conventional local config. Shadow the parent Vinext deploy redirect.
const redirect=new URL('../cloudflare-pages/.wrangler/deploy/config.json',import.meta.url);
mkdirSync(fileURLToPath(new URL('.',redirect)),{recursive:true});
writeFileSync(redirect,JSON.stringify({configPath:'../../wrangler.json'})+'\n');
const staging=preparePagesDeployment(config,pages);
try{
 const deploy=spawnSync(process.execPath,[wrangler,'pages','deploy',staging.output,'--project-name',config.name,'--branch','main','--commit-dirty=true'],{...options,cwd:staging.directory,stdio:'inherit'});
 if(deploy.error)throw deploy.error;
 process.exitCode=deploy.status??1;
}finally{rmSync(staging.directory,{recursive:true,force:true});}
