'use client';

import {useEffect,useId,useRef,useState} from 'react';
import {Sparkles,X,Send} from 'lucide-react';
import type {AssistantAnswer,AssistantMemory} from '../cloud/public/assistant-types';
import type {PrivateAssistantForm,PrivateAssistantReply} from '../lib/private-assistant-types';
import type {RailJob,RailSearch} from '../lib/rail-types';

type Message={role:'user'|'assistant';text:string;answer?:AssistantAnswer};
type Props={form:PrivateAssistantForm;job:RailJob|null;queryBusy:boolean;hidden:boolean;onBusy:(busy:boolean)=>void;onSearch:(input:RailSearch)=>Promise<RailJob|null>;onCancel:(id:string)=>Promise<void>;onPlan:(id:string)=>boolean;onSort:(sort:AssistantMemory['sort'])=>void};
const clock=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
const money=(value:number|null)=>value===null?'票价待确认':`¥${value}`;
export default function PrivateAssistant(props:Props){
 const id=useId(),[open,setOpen]=useState(false),[message,setMessage]=useState(''),[messages,setMessages]=useState<Message[]>([]),[busy,setBusy]=useState(false),[progress,setProgress]=useState('');
 const memory=useRef<AssistantMemory>({sort:'balanced',filters:{maxPrice:null,budgetScope:'person',latestArrival:null,maxDuration:null,directOnly:false,transferOnly:false,trainCodes:[]}}),history=useRef<string[]>([]),abort=useRef<AbortController|null>(null),pendingJob=useRef<string|null>(null),log=useRef<HTMLDivElement>(null),compose=useRef<HTMLTextAreaElement>(null),toggle=useRef<HTMLButtonElement>(null);
 const propsRef=useRef(props),waiting=useRef<{id:string;resolve:(job:RailJob)=>void;reject:(error:Error)=>void}|null>(null);
 useEffect(()=>{propsRef.current=props;const wait=waiting.current;if(!wait||props.job?.id!==wait.id)return;if(!['queued','running'].includes(props.job.status))wait.resolve(props.job);},[props]);
 useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight,behavior:'smooth'});},[messages,progress]);
 useEffect(()=>{if(!open)return;compose.current?.focus();const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);toggle.current?.focus();}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[open]);
 useEffect(()=>()=>{abort.current?.abort();},[]);
 const append=(value:Message)=>setMessages(current=>[...current.slice(-13),value]);
 async function request(body:Record<string,unknown>,signal:AbortSignal):Promise<PrivateAssistantReply>{
  const response=await fetch('/api/assistant',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  const data=await response.json() as PrivateAssistantReply&{error?:string};if(!response.ok)throw new Error(data.error||'AI 暂时不可用，请稍后重试。');return data;
 }
 async function waitForJob(created:RailJob,signal:AbortSignal):Promise<RailJob>{
  if(!['queued','running'].includes(created.status))return created;
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>failed(new Error('查询仍在进行，完成后可再问我比较结果。')),180000);
   const stopped=()=>failed(new Error('本轮对话已停止。'));
   const cleanup=()=>{clearTimeout(timeout);signal.removeEventListener('abort',stopped);waiting.current=null;};
   const done=(job:RailJob)=>{cleanup();resolve(job);},failed=(error:Error)=>{cleanup();reject(error);};
   waiting.current={id:created.id,resolve:done,reject:failed};signal.addEventListener('abort',stopped,{once:true});
   const current=propsRef.current.job;if(current?.id===created.id&&!['queued','running'].includes(current.status))done(current);else if(signal.aborted)stopped();
  });
 }
 async function send(text:string){
  if(busy||propsRef.current.queryBusy||!text.trim())return;
  const controller=new AbortController();abort.current=controller;setBusy(true);propsRef.current.onBusy(true);setMessage('');setProgress('正在理解你的出行需求…');append({role:'user',text});
  const context={message:text,history:history.current.slice(-3),form:propsRef.current.form,memory:memory.current};
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   timer=setTimeout(()=>controller.abort(),50000);
   let reply=await request({...context,jobId:propsRef.current.job?.id},controller.signal);clearTimeout(timer);
   history.current=[...history.current.slice(-2),text];
   if(reply.type==='search'){
    memory.current=reply.memory;setProgress('条件已填入工作台，正在由 Mac 核验官方余票…');
    const created=await propsRef.current.onSearch(reply.input);if(!created)throw new Error('查询未能启动，请查看工作台提示。');pendingJob.current=created.id;
    if(controller.signal.aborted){await propsRef.current.onCancel(created.id);throw new Error('本轮对话已停止。');}
    const finished=await waitForJob(created,controller.signal);pendingJob.current=null;
    if(finished.status==='waiting_user')throw new Error('Mac 需要你本人登录或处理验证。完成后重新查询，我再帮你比较。');
    if(!finished.result||!['complete','partial'].includes(finished.status))throw new Error(finished.message||'本轮没有取得可分析的实时结果。');
    setProgress('已取得本轮数据，正在比较价格与总用时…');timer=setTimeout(()=>controller.abort(),50000);
    reply=await request({...context,stage:'result',jobId:finished.id,memory:memory.current},controller.signal);
   }
   if(reply.type==='answer'){memory.current=reply.answer.memory;propsRef.current.onSort(reply.answer.memory.sort);append({role:'assistant',text:reply.answer.text,answer:reply.answer});}
  }catch(error){append({role:'assistant',text:controller.signal.aborted?'本轮对话已停止；已完成的查询结果仍可在工作台查看。':(error as Error).message});}
  finally{clearTimeout(timer);waiting.current?.reject(new Error('本轮已结束。'));waiting.current=null;pendingJob.current=null;abort.current=null;setBusy(false);setProgress('');propsRef.current.onBusy(false);}
 }
 function stop(){abort.current?.abort();if(pendingJob.current)void propsRef.current.onCancel(pendingJob.current).catch(()=>append({role:'assistant',text:'停止指令未送达，工作台查询可能仍在进行；可在查询结果处取消。'}));}
 return <div className="private-assistant" hidden={props.hidden}>
  <button ref={toggle} className="assistant-toggle" type="button" onClick={()=>setOpen(!open)} aria-expanded={open} aria-controls={id}><Sparkles size={17}/>AI 帮我查票</button>
  {open&&<aside id={id} className="assistant-panel" role="dialog" aria-label="私人 AI 查票助手"><div className="assistant-header"><div><strong>AI 查票助手 <span className="assistant-mode">私人工作台</span></strong><small>检索本工作台的新鲜余票，比较价格与时间</small></div><button type="button" className="assistant-close" aria-label="收起 AI 助手" onClick={()=>{setOpen(false);toggle.current?.focus();}}><X size={19}/></button></div>
   <div ref={log} className="assistant-log" role="log" aria-live="polite"><div className="assistant-bubble assistant">说出行程，我会填好查询条件、发起查询，再比较本轮方案。已有新鲜结果时，可直接问哪种更省、更快。<div className="assistant-examples">{['按当前表单查票，便宜优先','当前方案哪个用时最短','同车两段票和异车中转有什么区别'].map((text,index)=><button type="button" key={text} disabled={busy||props.queryBusy} onClick={()=>void send(text)}>{['按当前条件找更省的','比较最短用时','两段票怎么坐'][index]}</button>)}</div></div>
   {messages.map((item,index)=><div key={index} className={`assistant-bubble ${item.role}`}>{item.text}{item.answer?.citations.map(citation=><button type="button" className="assistant-citation" key={citation.id} onClick={()=>{if(props.onPlan(citation.id)){setOpen(false);toggle.current?.focus();}}}><strong>{citation.trains} · {money(citation.price)}</strong><span>{citation.route} · {citation.minutes} 分钟</span><span>{clock(citation.departure)} → {clock(citation.arrival)}</span>{citation.passengers>1&&<span>{citation.passengers} 位成人票面合计 {money(citation.groupPrice)}</span>}<span>{citation.label}</span><small>采集 {clock(citation.fetchedAt)} · 点击查看方案并重新核验</small></button>)}{!!item.answer?.citations.length&&<small className="assistant-source">每人票面合计 · 仅本轮已核验候选 · 余票随时变化</small>}</div>)}</div>
   {progress&&<div className="assistant-progress" role="status">{progress}</div>}
   <form className="assistant-form" onSubmit={event=>{event.preventDefault();void send(message.trim());}}><label htmlFor={`${id}-message`} className="sr-only">你的出行需求</label><textarea ref={compose} id={`${id}-message`} value={message} onChange={event=>setMessage(event.target.value)} maxLength={600} rows={2} placeholder="例如：明天杭州东到温州南，2 人，18 点前到，便宜优先" required disabled={busy}/><div className="assistant-compose"><small title="相关消息和归一化票段由 Cloudflare 云端模型处理；不会传递 12306 Cookie。需要新库存时使用私人 Mac 查询助手。">未提及的条件沿用表单 · 对话仅留本页</small><div className="assistant-controls">{busy?<button type="button" className="secondary" onClick={stop}>停止</button>:<button type="submit" className="primary" disabled={!message.trim()||props.queryBusy}><Send size={13}/>发送</button>}</div></div></form>
  </aside>}
 </div>;
}
