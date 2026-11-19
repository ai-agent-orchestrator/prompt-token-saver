import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '../dist');
const paths = [];
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    const relative = path.relative(root, name).replaceAll('\\', '/');
    if (relative === 'runtime' || relative === 'sw.js') continue;
    if (entry.isDirectory()) await walk(name);
    else paths.push(relative);
  }
}
await walk(root);
paths.sort();
const hash = createHash('sha256');
for (const file of paths) hash.update(await fs.readFile(path.join(root, file)));
hash.update(await fs.readFile(path.join(root, 'runtime/manifest.json')));
const version = hash.digest('hex').slice(0, 16);
await fs.writeFile(path.join(root, 'sw.js'), `// Generated app-shell cache. Never cache Drive requests, model files, or private documents.
const CACHE='ieo-shell-${version}';
const RUNTIME_CACHE='ieo-runtime-${version}';
const ASSETS=${JSON.stringify(paths)};
const base=new URL('./',self.location);
const shellUrls=new Set(ASSETS.map(file=>new URL(file,base).href));
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll([...shellUrls]))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('ieo-shell-')&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==base.origin||!url.pathname.startsWith(base.pathname)||url.search)return;
 const isShell=shellUrls.has(url.href)||request.mode==='navigate'&&url.pathname===base.pathname;
 const isRuntime=url.pathname.startsWith(new URL('runtime/',base).pathname)&&/\\.(?:js|wasm|json)$/.test(url.pathname);
 if(!isShell&&!isRuntime)return;
 event.respondWith((async()=>{
  const cache=await caches.open(isRuntime?RUNTIME_CACHE:CACHE);
  const cached=await cache.match(request.mode==='navigate'?new URL('index.html',base).href:request);
  if(cached)return cached;
  const response=await fetch(request);
  if(response.ok&&response.type!=='opaque')try{await cache.put(request,response.clone())}catch{}
  return response;
 })());
});
`);
console.log(`Service worker: ${paths.length} shell assets; runtime cached only on explicit use.`);
