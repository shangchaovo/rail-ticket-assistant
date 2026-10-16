import identity from '../../browser-extension/identity.json' with {type:'json'};

declare const RAIL_BROWSER_EXTENSION:boolean;
export const extensionMode=typeof RAIL_BROWSER_EXTENSION!=='undefined'&&RAIL_BROWSER_EXTENSION;
export function publicApiUrl(path:string,extension=extensionMode){
 if(!/^\/api\/public\/(?:stations(?:\?q=[^#]*)?|status|query|assistant)$/.test(path))throw new Error('查询接口地址无效。');
 return extension?new URL(path,identity.serviceOrigin).href:path;
}
export function apiFetch(path:string,options?:RequestInit){
 const url=publicApiUrl(path);
 return fetch(url,publicRequestOptions(options));
}
export function publicRequestOptions(options?:RequestInit,extension=extensionMode):RequestInit{
 // The public web page can share a host with the private workspace. Its requests
 // must not carry that workspace's session, even when a caller asks to include it.
 const headers=new Headers(options?.headers);
 for(const name of [...headers.keys()])if(name==='authorization'||name==='cookie'||name.startsWith('x-rail-')||name.startsWith('oai-'))headers.delete(name);
 return {...options,headers,credentials:'omit',...(extension?{mode:'cors' as const}:{})};
}
