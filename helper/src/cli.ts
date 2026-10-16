import {writeFile,access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {searchRail,recheckRail} from '../shared/rail-planner.ts';
import type {RailSearch,SearchResult} from '../shared/rail-types.ts';
import {loadConfig,setupConfig,setupFromStdin,setupSiteFromStdin} from './config.ts';
import {OfficialAdapter,PROFILE} from './official-adapter.ts';
import {QueueClient,QueueError} from './queue-client.ts';
import {chinaDate,SourceError} from './parsers.ts';
import {ProgressReporter} from './progress-reporter.ts';
import {acquireProcessLock,installService,startService,stopService,uninstallService,serviceStatus,waitForLocalUser,resumeLocalUser,notifyMac,preventIdleSleep} from './background-service.ts';
const sleep=(ms:number,signal?:AbortSignal)=>delay(ms,undefined,{signal}).catch(error=>{if(!(error instanceof Error)||error.name!=='AbortError')throw error;});
const command=process.argv[2]||'start';
const log=(message:string)=>console.log(`[${new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}] ${message}`);
function validateInput(input:RailSearch){
  if(!input||!input.origin||!Array.isArray(input.destinations)||input.destinations.length<1||input.destinations.length>10)throw new SourceError('查询站点不完整');
  for(const station of [input.origin,...input.destinations])if(!station||!/^\w{3}$/.test(station.code)||typeof station.name!=='string'||station.name.length>40)throw new SourceError('查询站点格式无效');
  chinaDate(input.date);
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.earliestTime)||!Array.isArray(input.trainTypes)||input.trainTypes.some(v=>!['G','D','C'].includes(v))||input.trainTypes.length===0||!Array.isArray(input.seats)||input.seats.some(v=>!['business','first','second','standing'].includes(v))||input.seats.length===0)throw new SourceError('查询偏好格式无效');
  if(input.passengerCount!==undefined&&(!Number.isInteger(input.passengerCount)||input.passengerCount<1||input.passengerCount>5))throw new SourceError('乘车人数应为 1 至 5 人');
  if(input.sameSeatOnly!==undefined&&typeof input.sameSeatOnly!=='boolean')throw new SourceError('同席别偏好格式无效');
  if(input.includeTransfer!==undefined&&typeof input.includeTransfer!=='boolean')throw new SourceError('中转偏好格式无效');
  if(input.minTransferMinutes!==undefined&&(!Number.isInteger(input.minTransferMinutes)||input.minTransferMinutes<20||input.minTransferMinutes>180))throw new SourceError('最短换乘等待应为 20 至 180 分钟');
  if(input.allowOvernightTransfer!==undefined&&typeof input.allowOvernightTransfer!=='boolean')throw new SourceError('次日换乘偏好格式无效');
  if(input.transferStations&&(!Array.isArray(input.transferStations)||input.transferStations.length>3||input.transferStations.some(s=>!s?.name||!/^[A-Z]{3}$/.test(s.code))))throw new SourceError('请选择最多 3 个有效中转站');
}
async function run(){
  const config=await loadConfig(),queue=new QueueClient(config),unlock=await acquireProcessLock();let stopped=false,activePrompt:AbortController|undefined;
  const shutdown=new AbortController(),adapter=new OfficialAdapter();
  const stop=()=>{stopped=true;shutdown.abort();activePrompt?.abort();queue.cancelPending();void adapter.close().catch(()=>{});log('正在停止助手…');};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const keepAwake=process.argv.includes('--prevent-idle-sleep')?preventIdleSleep():undefined;
  log(process.argv.includes('--background')?'查询助手在后台运行；电脑休眠、关机或断网时无法查询。':'查询助手已启动。请保持电脑联网；按 Control+C 停止。');
  if(keepAwake)log('已启用防空闲睡眠。合盖、手动休眠、关机和断网仍会中断查询。');
  try{
  while(!stopped){
    let claimed;try{claimed=await queue.claim();}catch(error){if(stopped)break;log(error instanceof Error?error.message:'云端连接失败');await sleep(10_000,shutdown.signal);continue;}
    if(stopped)break;
    if(!claimed){await sleep(10_000,shutdown.signal);continue;}
    const {job,leaseToken}=claimed;let cancelled=false,checking=false;let latest:SearchResult|undefined;
    const pendingUser=new AbortController();
    activePrompt=pendingUser;
    const heartbeat=setInterval(()=>{if(checking||stopped)return;checking=true;queue.status(job,leaseToken).then(value=>{cancelled=value;if(value)pendingUser.abort();}).catch(error=>{if(stopped)return;if(error instanceof Error&&/HTTP (401|409)/.test(error.message)){cancelled=true;pendingUser.abort();log('任务授权已失效，停止后续查询。');}else log('云端状态暂时无法同步，保留当前查询。');}).finally(()=>{checking=false;});},20_000);
    let notifiedAvailable=false;
    const notifyAvailable=(result:SearchResult)=>{
      if(notifiedAvailable)return;
      const passengers=job.input.passengerCount??1;
      const plans=result.plans.filter(plan=>plan.kind!=='extension'&&!plan.uncovered&&plan.legs.length>0&&(!job.input.sameSeatOnly||plan.legs.every(leg=>leg.seat===plan.legs[0].seat))&&plan.legs.every(leg=>leg.inventory.status==='available'&&(leg.inventory.count===undefined?passengers===1:leg.inventory.count>=passengers)));
      if(!plans.length)return;notifiedAvailable=true;
      const first=plans[0];
      void notifyMac(`${first.kind==='transfer'?first.legs.map(l=>l.train?.trainCode).join(' → '):first.train.trainCode} ${first.origin.name} → ${first.target.name} 出现 ${plans.length} 个可买方案。请打开同车余票重新核验并到 12306 购票。`).catch(()=>{});
    };
    const send=async(message:string,status:'running'|'waiting_user'='running',result?:SearchResult)=>{if(stopped)return;log(message);await queue.progress(job,leaseToken,status,message,result);if(result&&!stopped)notifyAvailable(result);};
    const progress=new ProgressReporter<{message:string;result:SearchResult}>(value=>send(value.message,'running',value.result));
    adapter.configureForJob({
      priceTrainNo:job.mode==='recheck'?job.recheckPlan?.train.trainNo:undefined,
      priceLegs:job.mode==='recheck'?job.recheckPlan?.legs:undefined,
      isCancelled:async()=>cancelled||stopped,
      onMessage:message=>log(message),
      waitForUser:async message=>{
        const initialResumeVersion=queue.resumeVersion();
        await progress.flush();
        await send(message,'waiting_user');
        await waitForLocalUser({jobId:job.id,message,signal:pendingUser.signal,resumeVersion:()=>queue.resumeVersion(),initialResumeVersion});
        await send('本人已确认处理完成；本次保留已确认结果，请重新查询新库存。');
      }
    });
    try{
      validateInput(job.input);
      let shownPlans=false;
      const hooks={isCancelled:async()=>cancelled||stopped,onProgress:async(result:SearchResult,message:string)=>{
        latest=result;
        progress.offer({message,result},!shownPlans&&result.plans.length>0);shownPlans=result.plans.length>0;
      }};
      if(job.mode==='recheck'&&!job.recheckPlan)throw new SourceError('复查方案缺失');
      const result=job.mode==='recheck'?await recheckRail(job.input,job.recheckPlan!,adapter,hooks):await searchRail(job.input,adapter,hooks);
      await progress.flush();
      if(!cancelled&&!stopped){await queue.result(job,leaseToken,result.complete?'complete':result.plans.length?'partial':'unavailable',result.complete?'查询已完成':result.plans.length?'部分区间已确认，请查看未完成事项':'未取得完整可核验数据，请在 12306 复核',result);notifyAvailable(result);}
    }catch(error){
      await progress.discard();
      const message=error instanceof SourceError||error instanceof QueueError?error.message:'查询未完成。请运行诊断并在 12306 复核。';log(message);
      if(!cancelled&&!stopped){
        if(latest){latest={...latest,complete:false,completedAt:new Date().toISOString(),issues:[...latest.issues,message]};}
        try{await queue.result(job,leaseToken,latest?.plans.length?'partial':'unavailable',message,latest);}
        catch{
          // A rejected large snapshot must still finish the job. Preserve the
          // last accepted partial snapshot rather than leaving it "running".
          try{await queue.result(job,leaseToken,latest?.plans.length?'partial':'unavailable',`${message} 已回传区间仅供参考，请减少查询条件后重试。`);}
          catch{log('结果上传失败，网页将提示任务超时。');}
        }
      }
    }finally{clearInterval(heartbeat);pendingUser.abort();activePrompt=undefined;await progress.discard();}
  }
  }finally{
    activePrompt?.abort();keepAwake?.kill();
    // Close again after the loop: a browser session that was still launching
    // when SIGTERM arrived may have completed after the first close request.
    await adapter.close().catch(()=>{});
    try{await queue.release();}catch{log('云端会话释放未完成，旧会话将在租约到期后恢复。');}
    await unlock();process.off('SIGINT',stop);process.off('SIGTERM',stop);
  }
}
async function diagnose(){
  console.log(`Node: ${process.versions.node}; 平台: ${process.platform}; 浏览器配置: ${PROFILE}`);
  try{await access(chromium.executablePath());console.log('Chromium: 已安装');}catch{console.log('Chromium: 未安装，请运行 npm run browser:install');}
  const adapter=new OfficialAdapter();
  try{console.log(`官方站名文件: 可读（${(await adapter.stations()).length} 站）`);}catch(error){console.log(error instanceof Error?error.message:'站名读取失败');}
  try{const config=await loadConfig({allowUnpaired:true});console.log(`网站: ${config.origin}；云端类型: ${config.provider}；设备令牌: ${config.deviceToken?'已配置':'待网页配对'}；Sites 服务凭据: ${config.provider==='cloudflare'?'无需':config.serviceToken?'已配置':'本地模式无需'}`);await new QueueClient(config).health();console.log('云端鉴权及队列: 已通过健康检查');}catch(error){console.log(error instanceof Error?error.message:'云端配置不可用');}
}
async function probe(){
  const [date,fromName='杭州东',toName='温州南']=process.argv.slice(3);chinaDate(date||'');
  const unlock=await acquireProcessLock();
  const adapter=new OfficialAdapter({onMessage:message=>log(message)});
  try{
    const stations=await adapter.stations(),from=stations.find(s=>s.name===fromName),to=stations.find(s=>s.name===toName);
    if(!from||!to)throw new SourceError('未找到指定站名');
    const rows=await adapter.query(from,to,date);
    let stops=null,stopIssue=null;
    if(rows.length){try{stops=await adapter.stops(rows.find(q=>/^[GDC]/.test(q.train.trainCode))||rows[0]);}catch(error){stopIssue=error instanceof Error?error.message:'经停未验证';}}
    const report={kind:'official-query-probe',fetchedAt:new Date().toISOString(),query:{from,to,date},rowCount:rows.length,rows,stops,stopIssue};
    await writeFile(new URL('../probe-result.json',import.meta.url),JSON.stringify(report,null,2),{mode:0o600});
    console.log(JSON.stringify({rowCount:rows.length,firstTrain:rows[0]?.train,stopCount:stops?.length??0,stopIssue,report:'helper/probe-result.json'},null,2));
  }catch(error){
    const message=error instanceof SourceError?error.message:'专用浏览器未完成官方查询';
    const diagnostic=error instanceof Error?`${error.name}: ${error.message.split('\n')[0].slice(0,300)}`:'Unknown';
    await writeFile(new URL('../probe-result.json',import.meta.url),JSON.stringify({kind:'official-query-probe',status:'unavailable',fetchedAt:new Date().toISOString(),query:{fromName,toName,date},message,diagnostic},null,2),{mode:0o600});
    console.log(JSON.stringify({status:'unavailable',message,diagnostic,report:'helper/probe-result.json'},null,2));process.exitCode=1;
  }finally{await adapter.close().catch(()=>{});await unlock();}
}
try{
  if(command==='setup')await setupConfig();
  else if(command==='setup-stdin')await setupFromStdin();
  else if(command==='setup-site-stdin')await setupSiteFromStdin();
  else if(command==='diagnose')await diagnose();
  else if(command==='probe')await probe();
  else if(command==='start')await run();
  else if(command==='resume')console.log(await resumeLocalUser());
  else if(command==='service-install'){await loadConfig();await access(chromium.executablePath()).catch(()=>{throw new Error('Chromium 未安装，请先运行 npm run browser:install。');});console.log(await installService({preventIdleSleep:process.argv.includes('--prevent-idle-sleep')}));}
  else if(command==='service-start')console.log(await startService());
  else if(command==='service-stop')console.log(await stopService());
  else if(command==='service-uninstall')console.log(await uninstallService());
  else if(command==='service-status')console.log(JSON.stringify(await serviceStatus(),null,2));
  else throw new Error('可用命令：setup、start、diagnose、probe、resume、service-install、service-start、service-stop、service-status、service-uninstall');
}catch(error){console.error(error instanceof SourceError||error instanceof Error?error.message:'操作失败');process.exitCode=1;}
