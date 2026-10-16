// Work around Workers SDK #9882 in local tests only; never deploy this config.
import {readFileSync,writeFileSync} from 'node:fs';
const source=new URL('../dist/server/wrangler.json',import.meta.url);
const config=JSON.parse(readFileSync(source,'utf8'));
delete config.assets;
config.name='rail-same-train-local-schedule-test';
config.workers_dev=false;
const target=new URL('../dist/server/wrangler-schedule-test.json',import.meta.url);
writeFileSync(target,JSON.stringify(config,null,2));
console.log('本地定时验收配置已生成：dist/server/wrangler-schedule-test.json（不要部署）');
