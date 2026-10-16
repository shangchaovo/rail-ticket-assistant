import identity from '../../browser-extension/identity.json' with {type:'json'};

export const EXTENSION_ORIGIN=identity.origin;
export const SERVICE_ORIGIN=identity.serviceOrigin;
export function extensionRequest(request:Request){
 return new URL(request.url).origin===SERVICE_ORIGIN&&request.headers.get('origin')===EXTENSION_ORIGIN;
}
export function publicClientOrigin(request:Request){
 return request.headers.get('origin')===new URL(request.url).origin||extensionRequest(request);
}
export function extensionApiPath(path:string){return /^\/api\/public\/(?:stations|status|query|assistant)$/.test(path);}
