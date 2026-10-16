import {z} from 'zod';
import {inputSchema,planSchema} from '../../lib/rail-validation.ts';
import {currentPlan,INVENTORY_FRESH_MS} from '../../lib/rail-freshness.ts';
import {recommendPlans} from '../../lib/rail-recommendation.ts';
import type {RailSearch,SearchResult,TicketPlan} from '../../lib/rail-types.ts';

const encoder=new TextEncoder();
const schema=z.object({v:z.literal(1),at:z.number().int(),exp:z.number().int(),input:inputSchema,plans:z.array(planSchema).max(24),complete:z.boolean(),issues:z.array(z.string().max(600)).max(8),total:z.number().int().min(0).max(240)}).strict();
export type Evidence=z.infer<typeof schema>;
function encode(bytes:Uint8Array){let value='';for(let i=0;i<bytes.length;i+=0x8000)value+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(value).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
function decode(value:string){if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error();return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));}
async function key(secret:string){return crypto.subtle.importKey('raw',encoder.encode('rail-assistant-evidence-v1:'+secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export function collectEvidence(input:RailSearch,result:SearchResult,now=Date.now()):Evidence{
 const current=result.plans.filter(p=>currentPlan(p,result.complete?'complete':'partial',now));
 // Include both price/time extremes; retrieve only a few of these fresh, signed facts for each answer.
 const choices=new Map<string,TicketPlan>();
 for(const mode of ['balanced','price','duration'] as const)for(const p of recommendPlans(current,mode).slice(0,8))choices.set(p.id,p);
 const plans=[...choices.values()].slice(0,24).map(p=>({...p,route:[],legs:p.legs.map(l=>({...l,route:[]}))}));
 return {v:1,at:now,exp:now+INVENTORY_FRESH_MS,input,plans,complete:result.complete,issues:result.issues.slice(0,8).map(v=>v.slice(0,600)),total:current.length};
}
export async function sealEvidence(input:RailSearch,result:SearchResult,secret:string,now=Date.now()):Promise<string>{
 const snapshot=collectEvidence(input,result,now);
 const payload=encode(encoder.encode(JSON.stringify(snapshot)));
 const signature=await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(payload));
 return payload+'.'+encode(new Uint8Array(signature));
}
export async function openEvidence(token:unknown,secret:string,now=Date.now()):Promise<Evidence|null>{
 if(typeof token!=='string'||token.length>200000||!secret)return null;
 try{
  const [payload,signature,...extra]=token.split('.');if(extra.length||!payload||!signature)return null;
  const sig=decode(signature);if(sig.length!==32||!await crypto.subtle.verify('HMAC',await key(secret),sig,encoder.encode(payload)))return null;
  const parsed=schema.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(payload))));if(!parsed.success)return null;
  const value=parsed.data;if(value.at>now+30000||value.exp<=now||value.exp-value.at>INVENTORY_FRESH_MS||value.exp<=value.at)return null;
  return {...value,plans:value.plans.filter(p=>currentPlan(p,value.complete?'complete':'partial',now))};
 }catch{return null;}
}
