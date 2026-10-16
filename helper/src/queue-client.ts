import type {RailJob,SearchResult} from '../shared/rail-types.ts';
import {packResult} from '../shared/rail-wire.ts';
import {isLocal,normalizedConfig,type Config} from './config.ts';
import {randomUUID} from 'node:crypto';
export class QueueError extends Error {}
export class QueueClient{
  private config:Config;
  private runnerId=randomUUID();
  private resume=0;
  private pending=new Set<AbortController>();
  cancelPending(){for(const controller of this.pending)controller.abort();}
  resumeVersion(){return this.resume;}
  constructor(config:Config){this.config=normalizedConfig(config,{allowUnpaired:true,stored:true});}
  private async request(path:string,body?:unknown,extraHeaders:Record<string,string>={}){
    if(!/^\/api\/helper\//.test(path))throw new QueueError('不允许访问非助手路径');
    if(!this.config.deviceToken&&path!=='/api/helper/health')throw new QueueError('设备尚未配对，请在网页生成设备令牌并运行 setup.command。');
    const headers:Record<string,string>={...extraHeaders};
    if(this.config.deviceToken)headers.Authorization=`Bearer ${this.config.deviceToken}`;
    headers['X-Rail-Runner-Id']=this.runnerId;
    if(this.config.provider==='sites'&&!isLocal(this.config.origin))headers['OAI-Sites-Authorization']=`Bearer ${this.config.serviceToken}`;
    if(body!==undefined)headers['Content-Type']='application/json';
    const serialized=body===undefined?undefined:JSON.stringify(body);
    if(serialized&&Buffer.byteLength(serialized)>1_950_000)throw new QueueError('查询结果超过单次上传容量，请减少备选到站或席别后重新查询。');
    const controller=new AbortController();this.pending.add(controller);
    try {
    const timeout=path==='/api/helper/release'?10_000:30_000;
    const r=await fetch(`${this.config.origin}${path}`,{method:body===undefined?'GET':'POST',headers,body:serialized,signal:AbortSignal.any([AbortSignal.timeout(timeout),controller.signal]),redirect:'error'});
    if(!r.ok){
      const responseText=await r.text();
      if(r.status===403&&/cf-error-details|Sorry, you have been blocked|Attention Required!.*Cloudflare/i.test(responseText)){
        const ray=r.headers.get('cf-ray')?.match(/^[a-zA-Z0-9-]{1,64}$/)?.[0];
        throw new QueueError(`网站访问被 Cloudflare 安全服务拦截（HTTP 403），尚未连到查询队列。请联系网站托管方检查访问规则${ray?`；Ray ID：${ray}`:''}。`);
      }
      const hint=this.config.provider==='sites'&&!isLocal(this.config.origin)?'请检查设备授权和 Sites 服务凭据。':'请检查网站地址及设备授权，必要时在网页重新配对。';
      if(r.status===400||r.status===413||r.status===409||r.status===426){
        let detail='查询结果未被云端接受';
        try{const parsed=JSON.parse(responseText);if(typeof parsed.error==='string')detail=parsed.error.slice(0,300);}catch{/* Never expose an HTML error response. */}
        throw new QueueError(`云端回传失败（HTTP ${r.status}）：${detail}。`);
      }
      throw new QueueError(`云端连接失败（HTTP ${r.status}）。${hint}`);
    }
    if(r.status===204)return null;
    try{return await r.json() as Record<string,unknown>;}catch{throw new QueueError('云端未返回助手数据，请检查网站地址、访问状态及设备授权。');}
    }finally{this.pending.delete(controller);}
  }
  async health(){const result=await this.request('/api/helper/health');if(result?.ready!==true||result.queue!=='ready')throw new QueueError('云端队列未就绪');return true;}
  async release(){await this.request('/api/helper/release',{});}
  async claim(){
    const result=await this.request('/api/helper/claim',{deviceId:this.config.deviceId,deviceName:this.config.deviceName,runnerId:this.runnerId});
    if(typeof result?.resumeVersion==='number')this.resume=result.resumeVersion;
    if(result===null||result.job===null)return null;
    if(!result||typeof result.leaseToken!=='string'||typeof result.job!=='object'||!result.job)throw new QueueError('云端任务格式无效');
    const job=result.job as RailJob;
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(job.id)||!Number.isInteger(job.version)||!['search','recheck'].includes(job.mode)||!job.input)throw new QueueError('云端任务身份无效');
    return {job,leaseToken:result.leaseToken};
  }
  async status(job:RailJob,leaseToken:string){const value=await this.request(`/api/helper/jobs/${encodeURIComponent(job.id)}/status`,undefined,{'X-Rail-Job-Version':String(job.version),'X-Rail-Lease-Token':leaseToken});if(typeof value?.resumeVersion==='number')this.resume=value.resumeVersion;return value?.cancelled===true;}
  async progress(job:RailJob,leaseToken:string,status:'running'|'waiting_user'|'partial',message:string,result?:SearchResult){
    await this.request(`/api/helper/jobs/${encodeURIComponent(job.id)}/progress`,{leaseToken,version:job.version,status,message,result:result?packResult(result):undefined});
  }
  async result(job:RailJob,leaseToken:string,status:'complete'|'partial'|'unavailable',message:string,result?:SearchResult){
    await this.request(`/api/helper/jobs/${encodeURIComponent(job.id)}/result`,{leaseToken,version:job.version,status,message,result:result?packResult(result):undefined});
  }
}
