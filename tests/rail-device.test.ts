import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {RUNNER_CLAIM_SQL,RUNNER_RENEW_SQL,RUNNER_RELEASE_JOBS_SQL} from '../lib/rail-device.ts';
const stamp='2026-10-06T01:00:00.000Z',until='2026-10-06T01:02:00.000Z';
test('migration revokes old tokens and prevents multiple active devices for one owner',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(readFileSync(new URL('../drizzle/0000_naive_jackpot.sql',import.meta.url),'utf8'));
  const insert=db.prepare("INSERT INTO devices (id,owner_id,token_hash,name,created_at) VALUES (?,'owner',?,'Mac',?)");
  insert.run('old','synthetic-old','2026-10-01T01:00:00Z');insert.run('new','synthetic-new',stamp);
  db.exec(readFileSync(new URL('../drizzle/0003_watches.sql',import.meta.url),'utf8'));
  assert.ok(db.prepare("SELECT revoked_at FROM devices WHERE id='old'").get()?.revoked_at);
  assert.equal(db.prepare("SELECT revoked_at FROM devices WHERE id='new'").get()?.revoked_at,null);
  assert.throws(()=>insert.run('third','synthetic-third',stamp),/UNIQUE/);
 }finally{db.close();}
});
test('one device token admits one runner, renews it, and rejects the other until expiration',()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const file of ['0000_naive_jackpot.sql','0003_watches.sql'])db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
  db.prepare("INSERT INTO devices (id,owner_id,token_hash,name,created_at) VALUES ('device','owner','synthetic','Mac',?)").run(stamp);
  const acquire=db.prepare(RUNNER_CLAIM_SQL);
  assert.equal(acquire.get('runner-a',until,stamp,'device','runner-a',stamp,'runner-a')?.runner_id,'runner-a');
  assert.equal(acquire.get('runner-b',until,stamp,'device','runner-b',stamp,'runner-b'),undefined);
  assert.equal(acquire.get('runner-a',until,stamp,'device','runner-a',stamp,'runner-a')?.runner_id,'runner-a');
  const later='2026-10-06T01:03:00.000Z';assert.equal(acquire.get('runner-b','2026-10-06T01:05:00.000Z',later,'device','runner-b',later,'runner-b')?.runner_id,'runner-b');
  db.prepare('UPDATE devices SET revoked_at=?').run(later);assert.equal(acquire.get('runner-b',until,stamp,'device','runner-b',stamp,'runner-b'),undefined);
 }finally{db.close();}
});
test('stopping a stale runner cannot stop the new runner job, and accepted partial data survives release',()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const file of ['0000_naive_jackpot.sql','0003_watches.sql'])db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
  db.prepare("INSERT INTO devices (id,owner_id,token_hash,name,created_at,runner_id) VALUES ('device','owner','synthetic','Mac',?,'runner-b')").run(stamp);
  db.prepare("INSERT INTO jobs (id,owner_id,status,input_json,message,device_id,lease_token,result_json,created_at,updated_at) VALUES ('job','owner','running','{}','','device','lease','confirmed',?,?)").run(stamp,stamp);
  assert.equal(db.prepare(RUNNER_RELEASE_JOBS_SQL).run(stamp,'device','runner-a').changes,0);
  assert.equal(db.prepare(RUNNER_RELEASE_JOBS_SQL).run(stamp,'device','runner-b').changes,1);
  const row=db.prepare('SELECT * FROM jobs').get();assert.equal(row?.status,'unavailable');assert.equal(row?.result_json,'confirmed');assert.equal(row?.lease_token,null);
  db.prepare("UPDATE devices SET runner_id=NULL,runner_until=NULL,message='电脑查询助手已停止'").run();assert.equal(db.prepare(RUNNER_RENEW_SQL).get(until,stamp,'device','runner-b',stamp),undefined);
  db.prepare("INSERT INTO released_runners VALUES ('device','runner-b',?)").run(stamp);
  assert.equal(db.prepare(RUNNER_CLAIM_SQL).get('runner-b',until,stamp,'device','runner-b',stamp,'runner-b'),undefined);
  const restarted=db.prepare(RUNNER_CLAIM_SQL).get('runner-c',until,stamp,'device','runner-c',stamp,'runner-c');assert.equal(restarted?.runner_id,'runner-c');assert.equal(restarted?.message,'电脑查询助手在线');
 }finally{db.close();}
});
