import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';

/** Give Pages a conventional config without redirecting a raw config with envs. */
export function preparePagesDeployment(config,pagesDirectory){
 const runtime=join(pagesDirectory,'.wrangler');
 mkdirSync(runtime,{recursive:true});
 const directory=mkdtempSync(join(runtime,'pages-deploy-'));
 const output=relative(directory,resolve(pagesDirectory,config.pages_build_output_dir));
 const staged={...config,pages_build_output_dir:output};
 writeFileSync(join(directory,'wrangler.json'),JSON.stringify(staged,null,2)+'\n',{mode:0o600});
 // Shadow any parent Vinext redirect. Point at the same user config so Wrangler
 // keeps its production/preview environments instead of treating it as generated.
 const redirect=join(directory,'.wrangler','deploy');
 mkdirSync(redirect,{recursive:true});
 writeFileSync(join(redirect,'config.json'),JSON.stringify({configPath:'../../wrangler.json'})+'\n');
 return {directory,output};
}
