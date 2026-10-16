import handler from 'vinext/server/fetch-handler';
import { privateConfig, readPrivateSession } from '../lib/private-auth';
import {tickWatches,flushNotifications} from '../lib/rail-watch';

const worker = {
  async scheduled(_event:ScheduledController, env:Cloudflare.Env, ctx:ExecutionContext) {
    if(env.RAIL_AUTH_MODE!=='private'||!env.DB)return;
    ctx.waitUntil(tickWatches(env.DB).then(()=>flushNotifications(env.DB!)));
  },
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    if (env.RAIL_AUTH_MODE !== 'private') return new Response('私人网站尚未完成配置', {status:503, headers:{'Cache-Control':'no-store'}});
    // Sites gateway identity is not available on an independently hosted Worker.
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith('oai-authenticated-user-') || name === 'oai-sites-authorization') headers.delete(name);
    }
    request = new Request(request, { headers });
    const url = new URL(request.url);
    let canonicalPath = url.pathname;
    try {
      for (let index=0;index<4 && canonicalPath.includes('%');index++) canonicalPath=decodeURIComponent(canonicalPath);
      if (canonicalPath.includes('%') || /[\\\u0000-\u001f\u007f]/.test(canonicalPath)) throw new Error('Invalid path');
      canonicalPath=new URL(canonicalPath.replace(/\/+/g,'/'),url.origin).pathname;
    } catch { return new Response('请求路径无效',{status:400}); }
    if (canonicalPath === '/downloads' || canonicalPath.startsWith('/downloads/')) {
      const config = privateConfig(env);
      if (!config) return new Response('私人网站尚未完成配置', {status:503, headers:{'Cache-Control':'no-store'}});
      if (!await readPrivateSession(request.headers.get('cookie'), config)) {
        return Response.redirect(`${url.origin}/login?return_to=${encodeURIComponent(url.pathname)}`, 303);
      }
      if (!env.ASSETS) return new Response('下载服务暂时不可用', {status:503});
      const response = await env.ASSETS.fetch(request);
      const result = new Response(response.body, response);
      result.headers.set('Cache-Control', 'private, no-store');
      return result;
    }
    // Assets are routed through this Worker so encoded private paths cannot skip
    // authentication. Serve the explicitly public CSS/JS bundle here as well.
    if (env.ASSETS && (canonicalPath.startsWith('/_next/static/') || canonicalPath==='/favicon.svg')) {
      return env.ASSETS.fetch(request);
    }
    const response = await handler.fetch(request, env, ctx);
    if(env.DB&&request.method==='POST'&&/^\/api\/helper\//.test(url.pathname))ctx.waitUntil(flushNotifications(env.DB));
    const result = new Response(response.body, response);
    result.headers.set('X-Content-Type-Options', 'nosniff');
    result.headers.set('Referrer-Policy', 'same-origin');
    result.headers.set('X-Frame-Options', 'DENY');
    result.headers.set('Cache-Control', 'private, no-store');
    return result;
  },
};
export default worker;
