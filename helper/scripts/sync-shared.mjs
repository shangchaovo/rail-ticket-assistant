import {copyFile, mkdir, access} from 'node:fs/promises';
const dest = new URL('../shared/', import.meta.url);
await mkdir(dest, {recursive:true});
for (const name of ['rail-types.ts','rail-planner.ts','rail-wire.ts','rail-recommendation.ts']) {
  const source = new URL(`../../lib/${name}`, import.meta.url);
  try {await access(source); await copyFile(source, new URL(name, dest));}
  catch {await access(new URL(name, dest));}
}
