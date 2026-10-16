// Public queries and the private workspace use isolated service bindings.
// Private authentication, downloads, D1 and secrets stay in rail-same-train.
function unavailable() {
  return new Response('服务暂不可用，请稍后重试。', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const bridge = {
  async fetch(request, env) {
    const url=new URL(request.url),publicEnabled=env?.PUBLIC_FRONTEND==='true';
    if(publicEnabled&&url.pathname==='/workspace')return Response.redirect(`${url.origin}/?workspace=1`,303);
    const publicRoute=publicEnabled&&((url.pathname==='/'&&!url.searchParams.has('query')&&!url.searchParams.has('workspace'))||url.pathname.startsWith('/api/public/')||url.pathname.startsWith('/public-assets/'));
    const backend=publicRoute?env?.PUBLIC_BACKEND:env?.RAIL_BACKEND;
    if (typeof backend?.fetch !== 'function') return unavailable();
    try {
      // Private requests retain their credentials and original URL. The public
      // service must never receive workspace sessions or helper credentials.
      let forwarded=request;
      if(publicRoute){
        const headers=new Headers(request.headers);
        for(const name of [...headers.keys()])if(name==='cookie'||name==='authorization'||name.startsWith('x-rail-')||name.startsWith('oai-'))headers.delete(name);
        forwarded=new Request(request,{headers});
      }
      const response=await backend.fetch(forwarded);
      if(publicEnabled&&!publicRoute&&url.searchParams.has('workspace')&&[301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');
        if(location){const target=new URL(location,url.origin);if(target.origin===url.origin&&target.pathname==='/login'){
          target.searchParams.set('return_to',url.pathname+url.search);
          const result=new Response(response.body,response);result.headers.set('Location',target.toString());return result;
        }}
      }
      return response;
    } catch {
      // Never fall back to Pages ASSETS or an unauthenticated Internet fetch.
      return unavailable();
    }
  },
};
export default bridge;
