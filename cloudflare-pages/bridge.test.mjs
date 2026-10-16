import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import bridge from './dist/_worker.js';

const base = 'https://rail-same-train-pages.pages.dev';

test('missing or malformed service binding fails closed with no static fallback', async () => {
  let assetCalls = 0;
  for (const backend of [undefined, {}, {fetch: 'invalid'}]) {
    const response = await bridge.fetch(new Request(`${base}/downloads/rail-helper.zip`), {
      RAIL_BACKEND: backend, ASSETS: {fetch() {assetCalls++; throw new Error('Must not run');}},
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('location'), null);
  }
  assert.equal(assetCalls, 0);
});

test('backend exception returns generic 503 without exception details or asset fallback', async () => {
  let assetCalls = 0;
  const response = await bridge.fetch(new Request(`${base}/api/jobs`), {
    RAIL_BACKEND: {async fetch() {throw new Error('internal detail must remain private');}},
    ASSETS: {fetch() {assetCalls++; return new Response('Unexpected fallback');}},
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await response.text(), /internal detail|Unexpected fallback/);
  assert.equal(assetCalls, 0);
});

test('passes the exact Request preserving Pages URL, Origin, body and credential headers', async () => {
  const body = JSON.stringify({action: 'logout'});
  const request = new Request(`${base}/api/auth?returnTo=%2F`, {
    method: 'POST', redirect: 'manual', body,
    headers: {Origin: base, 'Content-Type': 'application/json', Cookie: 'rail_session=test-fixture',
      Authorization: 'Bearer test-fixture', 'oai-authenticated-user-id': 'forged-fixture'},
  });
  const expected = new Response(null, {status: 303, headers: {Location: `${base}/login`}});
  const response = await bridge.fetch(request, {RAIL_BACKEND: {async fetch(forwarded) {
    assert.strictEqual(forwarded, request);
    assert.equal(forwarded.url, `${base}/api/auth?returnTo=%2F`);
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.redirect, 'manual');
    assert.equal(forwarded.headers.get('Origin'), base);
    assert.equal(forwarded.headers.get('Cookie'), 'rail_session=test-fixture');
    assert.equal(forwarded.headers.get('Authorization'), 'Bearer test-fixture');
    // Backend owns stripping and authentication; the bridge adds no identity trust.
    assert.equal(forwarded.headers.get('oai-authenticated-user-id'), 'forged-fixture');
    assert.equal(await forwarded.text(), body);
    return expected;
  }}});
  assert.strictEqual(response, expected);
});

test('forwards all paths and methods including encoded downloads and public assets', async () => {
  const calls = [];
  let assetCalls = 0;
  const backend = {async fetch(request) {calls.push(request); return new Response(null, {status: 401});}};
  for (const [method, path] of [
    ['GET', '/?workspace=1'], ['GET', '/login'], ['GET', '/api/stations?q=station'],
    ['POST', '/api/helper/claim'], ['GET', '/downloads/rail-helper.zip'],
    ['GET', '/%64ownloads/rail-helper.zip'], ['GET', '/downloads%2Frail-helper.zip'],
    ['GET', '/_next/static/chunks/app.js'], ['HEAD', '/_next/static/css/app.css'],
    ['OPTIONS', '/api/auth'],
  ]) {
    const request = new Request(`${base}${path}`, {method});
    const response = await bridge.fetch(request, {
      RAIL_BACKEND: backend,
      ASSETS: {fetch() {assetCalls++; return new Response('Must not run');}},
    });
    assert.equal(response.status, 401);
    assert.strictEqual(calls.at(-1), request);
  }
  assert.equal(calls.length, 10);
  assert.equal(assetCalls, 0);
});

test('preserves backend cookie, redirect and cache policy without adding CORS', async () => {
  const expected = new Response(null, {status: 303, headers: {
    Location: `${base}/login?return_to=%2Fdownloads%2Frail-helper.zip`,
    'Set-Cookie': 'rail_session=test-fixture; Path=/; Secure; HttpOnly; SameSite=Strict',
    'Cache-Control': 'private, no-store',
  }});
  const response = await bridge.fetch(new Request(`${base}/downloads/rail-helper.zip`), {
    RAIL_BACKEND: {async fetch() {return expected;}},
  });
  assert.strictEqual(response, expected);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), expected.headers.get('Location'));
  assert.equal(response.headers.get('Set-Cookie'), expected.headers.get('Set-Cookie'));
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('streams binary asset response without reading or transforming its body', async () => {
  const bytes = new Uint8Array([0, 255, 128, 1]);
  const expected = new Response(bytes, {headers: {'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, no-store'}});
  const response = await bridge.fetch(new Request(`${base}/downloads/file.bin`), {
    RAIL_BACKEND: {async fetch() {return expected;}},
  });
  assert.strictEqual(response, expected);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('deployment config isolates public backend and keeps private backend out of previews', async () => {
  const config = JSON.parse(await readFile(new URL('./wrangler.json', import.meta.url), 'utf8'));
  const routes = JSON.parse(await readFile(new URL('./dist/_routes.json', import.meta.url), 'utf8'));
  assert.equal(config.pages_build_output_dir, './dist');
  assert.equal(config.compatibility_date, '2026-05-15');
  assert.ok(config.compatibility_flags.includes('nodejs_compat'));
  assert.deepEqual(config.services, [{binding: 'RAIL_BACKEND', service: 'rail-same-train', environment: 'production'},{binding:'PUBLIC_BACKEND',service:'rail-query-public',environment:'production'}]);
  assert.deepEqual(config.env.preview.services, [{binding:'PUBLIC_BACKEND',service:'rail-query-public',environment:'production'}]);
  assert.equal(config.main, undefined);
  assert.equal(config.d1_databases, undefined);
  assert.deepEqual(config.vars,{PUBLIC_FRONTEND:'true'});
  assert.deepEqual(routes, {version: 1, include: ['/*'], exclude: []});
});

test('public root and query routes use only the public backend while owner APIs stay private',async()=>{
 const calls=[];const env={PUBLIC_FRONTEND:'true',PUBLIC_BACKEND:{fetch:async r=>{calls.push('public:'+new URL(r.url).pathname);return new Response('public');}},RAIL_BACKEND:{fetch:async r=>{calls.push('private:'+new URL(r.url).pathname);return new Response('private');}}};
 for(const path of ['/','/api/public/query','/public-assets/app.js'])assert.equal(await(await bridge.fetch(new Request(base+path),env)).text(),'public');
 for(const path of ['/?query=legacy-private-job','/?workspace=1','/api/device','/api/jobs/id','/api/helper/claim','/login','/downloads/rail-helper.zip'])assert.equal(await(await bridge.fetch(new Request(base+path),env)).text(),'private');
 assert.equal(calls.filter(v=>v.startsWith('public:')).length,3);
});
test('workspace redirects retain the private destination through the login flow',async()=>{
 const entry=await bridge.fetch(new Request(base+'/workspace'),{PUBLIC_FRONTEND:'true'});assert.equal(entry.status,303);assert.equal(entry.headers.get('location'),base+'/?workspace=1');
 const response=await bridge.fetch(new Request(base+'/?workspace=1'),{PUBLIC_FRONTEND:'true',RAIL_BACKEND:{fetch:async()=>Response.redirect(base+'/login?return_to=%2F',303)}});
 assert.equal(new URL(response.headers.get('location')).searchParams.get('return_to'),'/?workspace=1');
});
test('missing public backend never falls back to the private workbench',async()=>{
 let privateCalls=0;const response=await bridge.fetch(new Request(base+'/'),{PUBLIC_FRONTEND:'true',RAIL_BACKEND:{fetch:async()=>{privateCalls++;return new Response('private');}}});
 assert.equal(response.status,503);assert.equal(privateCalls,0);
});
test('public service receives no private session, bearer token, runner lease or gateway identity',async()=>{
 const body=JSON.stringify({input:'test-only'});
 const request=new Request(base+'/api/public/query',{method:'POST',headers:{Origin:base,Cookie:'rail_session=test-only',Authorization:'Bearer test-only','X-Rail-Runner-Id':'test-only','oai-authenticated-user-id':'test-only','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body});
 const response=await bridge.fetch(request,{PUBLIC_FRONTEND:'true',PUBLIC_BACKEND:{async fetch(forwarded){
  for(const name of ['Cookie','Authorization','X-Rail-Runner-Id','oai-authenticated-user-id'])assert.equal(forwarded.headers.get(name),null);
  assert.equal(forwarded.url,request.url);assert.equal(forwarded.headers.get('Origin'),base);assert.equal(forwarded.headers.get('CF-Connecting-IP'),'192.0.2.1');assert.equal(await forwarded.text(),body);
  return new Response('public-only');
 }}});
 assert.equal(await response.text(),'public-only');
});
