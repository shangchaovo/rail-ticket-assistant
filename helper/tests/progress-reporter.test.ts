import test from 'node:test';
import assert from 'node:assert/strict';
import {ProgressReporter} from '../src/progress-reporter.ts';
test('查询不等待云端上传，慢上传只保留最新进度，最终更新前 flush',async()=>{
  let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve});const seen:number[]=[];
  const reporter=new ProgressReporter<number>(async value=>{seen.push(value);if(value===0)await blocked;},10_000);
  reporter.offer(0);for(let i=1;i<=50;i++)reporter.offer(i);
  assert.deepEqual(seen,[0]);
  const finished=reporter.flush();release();await finished;
  assert.deepEqual(seen,[0,50]);seen.push(51);assert.deepEqual(seen,[0,50,51]);
});
test('取消丢弃尚未上传的快照，不留下定时任务',async()=>{
  let release!:()=>void;const seen:number[]=[];
  const reporter=new ProgressReporter<number>(async value=>{seen.push(value);await new Promise<void>(resolve=>{release=resolve});});
  reporter.offer(1);reporter.offer(2);const cancelled=reporter.discard();release();await cancelled;
  await reporter.flush();assert.deepEqual(seen,[1]);
});
test('最后一次上传失败不能悄悄返回成功',async()=>{
  const reporter=new ProgressReporter<number>(async()=>{throw new Error('lease expired');});
  reporter.offer(1);await assert.rejects(reporter.flush(),/lease expired/);
});
