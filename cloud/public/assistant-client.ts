import type {AssistantAnswer,AssistantEvent,AssistantMemory,AssistantQueryResult,FormDraft} from './assistant-types.ts';
import {apiFetch} from './transport.ts';
type Options={getForm:()=>FormDraft;getEvidence:()=>string|undefined;setEvidence:(token:string)=>void;setBusy:(value:boolean)=>void;onSearch:(input:AssistantQueryResult['input'])=>void;onResult:(data:AssistantQueryResult)=>void;onAnswer:(memory:AssistantMemory)=>void;onPlan:(id:string)=>boolean;onError:(message:string)=>void};
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const stamp=(iso:string)=>new Date(Date.parse(iso)+8*3600000).toISOString().slice(5,16).replace('T',' ');
export function initAssistant(options:Options){
 document.getElementById('assistant-nav')?.addEventListener('click',()=>document.getElementById('assistant-toggle')?.click());
 const panel=$('assistant-panel'),toggle=$<HTMLButtonElement>('assistant-toggle'),log=$('assistant-log'),message=$<HTMLTextAreaElement>('assistant-message'),send=$<HTMLButtonElement>('assistant-send'),stop=$<HTMLButtonElement>('assistant-stop'),progress=$('assistant-progress');
 let busy=false,externalBusy=false,available=true,controller:AbortController|undefined,memory:AssistantMemory|undefined;
 const history:string[]=[];
 const controls=()=>{send.disabled=busy||externalBusy||!available;message.disabled=busy||externalBusy;stop.hidden=!busy;toggle.classList.toggle('working',busy);};
 function bubble(text:string,role:'user'|'assistant'){
  const row=document.createElement('div');row.className='assistant-bubble '+role;row.textContent=text;log.appendChild(row);
  while(log.children.length>14)log.firstElementChild?.remove();row.scrollIntoView({block:'nearest'});return row;
 }
 function open(){panel.hidden=false;toggle.setAttribute('aria-expanded','true');message.focus();}
 function close(){panel.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();}
 function answer(data:AssistantAnswer){
  memory=data.memory;options.onAnswer(data.memory);if(data.evidenceToken)options.setEvidence(data.evidenceToken);
  const row=bubble(data.text,'assistant');
  for(const citation of data.citations){
   const card=document.createElement('button');card.type='button';card.className='assistant-citation';
   const train=document.createElement('strong');train.textContent=citation.trains;
   const route=document.createElement('span');route.textContent=citation.route+' · '+citation.label;
   const fare=document.createElement('span');fare.textContent=(citation.price===null?'票价待确认':`¥${citation.price} / 人${citation.passengers>1?' · '+citation.passengers+' 人 ¥'+citation.groupPrice:''}`)+' · '+Math.floor(citation.minutes/60)+'小时'+(citation.minutes%60?' '+citation.minutes%60+'分':'');
   const when=document.createElement('small');when.textContent=stamp(citation.departure)+' → '+stamp(citation.arrival)+' · 采集 '+stamp(citation.fetchedAt)+'　查看票段 ↗';
   for(const child of [train,route,fare,when])card.appendChild(child);card.addEventListener('click',()=>{if(options.onPlan(citation.id))close();else bubble('这条引用已失效或对应其他查询，请重新查询新库存。','assistant');});row.appendChild(card);
  }
  if(data.sampledAt){const source=document.createElement('small');source.className='assistant-source';source.textContent='依据本轮官方查询 · '+stamp(data.sampledAt)+' · 库存会变化';row.appendChild(source);}
  row.scrollIntoView({block:'nearest'});
 }
 async function submit(text:string){
  if(busy||externalBusy||!available||!text.trim())return;
  if(text.trim().length>600){bubble('请将需求缩短到 600 字以内。','assistant');return;}
  const question=text.trim(),previous=history.slice(-3);history.push(question);message.value='';bubble(question,'user');busy=true;controls();options.setBusy(true);progress.hidden=false;progress.textContent='正在理解你的需求…';controller=new AbortController();
  let finished=false;const timeout=setTimeout(()=>controller?.abort(),85000);
  try{
   const response=await apiFetch('/api/public/assistant',{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},signal:controller.signal,body:JSON.stringify({message:question,history:previous,form:options.getForm(),memory,evidenceToken:options.getEvidence()})});
   if(!response.ok){const data=await response.json().catch(()=>({})) as {error?:string};throw Error(data.error||'AI 暂时不可用，仍可使用条件查询。');}
   if(!response.body)throw Error('本轮未收到回复，请稍后重试。');
   const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
   for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let end;
    while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=event.split('\n').find(s=>s.startsWith('data: '));if(!line)continue;const data=JSON.parse(line.slice(6)) as AssistantEvent;
     if(data.type==='progress')progress.textContent=data.message;
     if(data.type==='search')options.onSearch(data.input);
     if(data.type==='result')options.onResult(data.data);
     if(data.type==='answer'){answer(data.data);finished=true;}
     if(data.type==='error')throw Error(data.message);
    }
   }
   if(!finished)throw Error('对话连接已中断，请重试；未收到确认的数据不能当作当前有票。');
  }catch(e){const text=e instanceof Error&&e.name==='AbortError'?'本轮对话已停止。需要新库存时请重新发送。':e instanceof Error?e.message:'AI 暂时不可用，请稍后重试。';bubble(text,'assistant');options.onError(text);}
  finally{clearTimeout(timeout);busy=false;options.setBusy(false);controls();progress.hidden=true;message.focus();}
 }
 toggle.addEventListener('click',()=>panel.hidden?open():close());$('assistant-close').addEventListener('click',close);
 $('assistant-form').addEventListener('submit',event=>{event.preventDefault();void submit(message.value);});
 message.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void submit(message.value);}});
 stop.addEventListener('click',()=>controller?.abort());
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden)close();});
 for(const button of document.querySelectorAll<HTMLButtonElement>('[data-ask]'))button.addEventListener('click',()=>{open();void submit(button.dataset.ask!);});
 void apiFetch('/api/public/status').then(r=>r.json() as Promise<{assistantEnabled?:boolean}>).then(data=>{available=data.assistantEnabled===true;if(!available){progress.hidden=false;progress.textContent='AI 服务暂不可用，仍可使用条件查询。';}controls();}).catch(()=>{});
 return {setExternalBusy(value:boolean){externalBusy=value;controls();},resetContext(){memory=undefined;history.length=0;}};
}
