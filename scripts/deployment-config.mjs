import {existsSync,readFileSync} from 'node:fs';
const names={public:'wrangler.public.json',private:'wrangler.cloudflare.json',pages:'cloudflare-pages/wrangler.json'};
export function readDeploymentConfig(kind){
 const standard=names[kind];if(!standard)throw new Error('Unknown deployment target');
 const local=standard.replace(/\.json$/,'.local.json');
 const configPath=existsSync(new URL('../'+local,import.meta.url))?local:standard;
 return {configPath,config:JSON.parse(readFileSync(new URL('../'+configPath,import.meta.url),'utf8'))};
}
