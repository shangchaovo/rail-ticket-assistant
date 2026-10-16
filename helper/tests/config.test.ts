import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizedConfig,validatedProvider} from '../src/config.ts';
const base={origin:'https://rail-test.example.workers.dev',deviceId:'synthetic-device',deviceName:'test',deviceToken:'synthetic-device-token'};

test('Cloudflare 配置拒绝 Sites 凭据，读取旧钥匙串时安全丢弃残留值',()=>{
  assert.throws(()=>normalizedConfig({...base,provider:'cloudflare',serviceToken:'synthetic-sites-token'}),/不接受 Sites/);
  assert.equal(normalizedConfig({...base,provider:'cloudflare',serviceToken:'stale-sites-token'},{stored:true}).serviceToken,'');
  assert.equal(normalizedConfig({...base,provider:'cloudflare'}).provider,'cloudflare');
  assert.throws(()=>normalizedConfig({...base,provider:'cloudflare',origin:'http://rail-test.example.workers.dev'}),/HTTPS/);
  assert.throws(()=>normalizedConfig({...base,provider:'cloudflare',origin:'https://rail-test.example.workers.dev/foreign'}),/origin/);
});

test('旧配置默认 Sites 且远程必须有服务凭据，本地调试保持可用',()=>{
  assert.equal(validatedProvider(undefined),'sites');assert.equal(validatedProvider(''),'sites');
  assert.throws(()=>validatedProvider('other'),/cloudflare/);
  assert.throws(()=>normalizedConfig({...base,origin:'https://synthetic.chatgpt.site'}),/服务凭据/);
  assert.equal(normalizedConfig({...base,origin:'https://synthetic.chatgpt.site',serviceToken:'synthetic-sites-token'}).provider,'sites');
  for(const provider of ['sites','cloudflare'] as const)assert.equal(normalizedConfig({...base,provider,origin:'http://127.0.0.1:3000'}).origin,'http://127.0.0.1:3000');
});

test('未配对配置只用于诊断，正常启动必须提供合法设备令牌',()=>{
  assert.throws(()=>normalizedConfig({...base,provider:'cloudflare',deviceToken:''}),/设备令牌/);
  assert.equal(normalizedConfig({...base,provider:'cloudflare',deviceToken:''},{allowUnpaired:true}).deviceToken,'');
  assert.throws(()=>normalizedConfig({...base,provider:'cloudflare',deviceToken:'bad token'}),/格式/);
});
