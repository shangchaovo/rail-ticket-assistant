import test from 'node:test';
import assert from 'node:assert/strict';
import {transferCandidates} from '../src/transfer-stations.ts';
import {OfficialAdapter} from '../src/official-adapter.ts';
import type {SegmentQuote} from '../shared/rail-types.ts';
const from={name:'温州南',code:'VRH'},to={name:'香港西九龙',code:'XJA'};
const hubs=[{name:'深圳北',code:'IOQ'},{name:'广州南',code:'IZQ'},{name:'潮汕',code:'CBQ'},{name:'厦门北',code:'XKS'},{name:'杭州东',code:'HGH'}];
test('Hong Kong discovery is bounded and uses actual official stations, not same-city substitutions',()=>{
  assert.deepEqual(transferCandidates(from,to,[from,to,...hubs]).stations.map(s=>s.name),['深圳北','广州南','潮汕','厦门北']);
  const changed=hubs.map(s=>s.name==='深圳北'?{...s,name:'深圳'}:s);
  assert.ok(!transferCandidates(from,to,[from,to,...changed]).stations.some(s=>s.code==='IOQ'));
  assert.ok(transferCandidates(hubs[0],to,[hubs[0],to,...hubs]).stations.every(s=>s.code!=='IOQ'));
});
test('geographic hints cannot turn missing or ambiguous station locations into route or inventory claims',()=>{
  const result=transferCandidates({name:'未知站',code:'ZZZ'},{name:'别站',code:'YYY'},hubs);
  assert.equal(result.limited,true);assert.ok(result.stations.length<=4);
  assert.deepEqual(transferCandidates(from,to,[]).stations,[]);
});
test('price recheck recognizes the second train identity and never a same-number different service day',()=>{
  const train={trainNo:'internal-2',trainCode:'G2',runId:'2026-10-11:internal-2',serviceDate:'2026-10-11'};
  const departureIso='2026-10-11T06:35:00+08:00';
  const leg={from:hubs[0],to,departureIso,arrivalIso:'2026-10-11T07:00:00+08:00',fetchedAt:'2026-10-10T08:00:00Z',seat:'second' as const,inventory:{status:'available' as const,price:null},train};
  const adapter=new OfficialAdapter({priceTrainNo:'internal-1',priceLegs:[leg]});
  const checker=adapter as unknown as {missingCheckedPrice:(rows:SegmentQuote[])=>boolean};
  const q={train,from:leg.from,to:leg.to,departureIso,seats:{second:leg.inventory}} as SegmentQuote;
  assert.equal(checker.missingCheckedPrice([q]),true);
  assert.equal(checker.missingCheckedPrice([{...q,train:{...train,serviceDate:'2026-10-10'}}]),false);
});
