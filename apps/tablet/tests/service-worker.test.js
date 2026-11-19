import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { serviceWorkerSource } from '../scripts/service-worker-template.mjs';

function worker(online) {
  const handlers = {}, saved = [], deleted = [];
  let skipped = false, claimed = false;
  const cache = { match: async () => new Response('previous app'), put: async (url, response) => saved.push([url, await response.text()]), addAll: async () => {} };
  const self = { location: 'https://example.org/app/sw.js', addEventListener: (event, callback) => { handlers[event] = callback; }, skipWaiting: async () => { skipped = true; }, clients: { claim: async () => { claimed = true; } } };
  vm.runInNewContext(serviceWorkerSource('new-version', ['index.html']), { self, URL, caches: { open: async () => cache, keys: async () => ['ieo-shell-previous', 'unrelated'], delete: async key => deleted.push(key) }, fetch: async () => { if (!online) throw new Error('offline'); return new Response('latest app'); } });
  return { handlers, saved, deleted, skipped: () => skipped, claimed: () => claimed };
}
test('normal public URL prefers the latest HTML over an older installed app cache', async () => {
  const app = worker(true); let response;
  app.handlers.fetch({ request: { method: 'GET', url: 'https://example.org/app/', mode: 'navigate' }, respondWith: value => { response = value; } });
  assert.equal(await (await response).text(), 'latest app');
  assert.deepEqual(app.saved, [['https://example.org/app/index.html', 'latest app']]);
});
test('normal public URL still works offline and the updated worker takes control', async () => {
  const app = worker(false); let response, pending;
  app.handlers.fetch({ request: { method: 'GET', url: 'https://example.org/app/', mode: 'navigate' }, respondWith: value => { response = value; } });
  assert.equal(await (await response).text(), 'previous app');
  app.handlers.install({ waitUntil: value => { pending = value; } }); await pending;
  app.handlers.activate({ waitUntil: value => { pending = value; } }); await pending;
  assert.equal(app.skipped(), true); assert.equal(app.claimed(), true);
  assert.deepEqual(app.deleted, ['ieo-shell-previous']);
});
