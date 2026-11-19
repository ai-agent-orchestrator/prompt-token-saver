export function serviceWorkerSource(version, paths) {
  return `// Generated app-shell cache. Never cache Drive requests, model files, or private documents.
const CACHE='ieo-shell-${version}';
const RUNTIME_CACHE='ieo-runtime-${version}';
const ASSETS=${JSON.stringify(paths)};
const base=new URL('./',self.location);
const shellUrls=new Set(ASSETS.map(file=>new URL(file,base).href));
self.addEventListener('install',event=>{event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll([...shellUrls]);await self.skipWaiting();})());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(key=>key.startsWith('ieo-shell-')&&key!==CACHE).map(key=>caches.delete(key)));await self.clients.claim();})());});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==base.origin||!url.pathname.startsWith(base.pathname)||url.search)return;
 const isShell=shellUrls.has(url.href)||request.mode==='navigate'&&url.pathname===base.pathname;
 const isRuntime=url.pathname.startsWith(new URL('runtime/',base).pathname)&&/\\.(?:js|wasm|json)$/.test(url.pathname);
 if(!isShell&&!isRuntime)return;
 event.respondWith((async()=>{
  const cache=await caches.open(isRuntime?RUNTIME_CACHE:CACHE);
  if(request.mode==='navigate'){
   const indexUrl=new URL('index.html',base).href;
   try{
    const fresh=await fetch(request);
    if(fresh.ok){try{await cache.put(indexUrl,fresh.clone())}catch{}return fresh;}
    const offline=await cache.match(indexUrl);return offline||fresh;
   }catch(error){const offline=await cache.match(indexUrl);if(offline)return offline;throw error;}
  }
  const cached=await cache.match(request);
  if(cached)return cached;
  const response=await fetch(request);
  if(response.ok&&response.type!=='opaque')try{await cache.put(request,response.clone())}catch{}
  return response;
 })());
});
`;
}
