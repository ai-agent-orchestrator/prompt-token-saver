import { serviceWorkerSource } from './service-worker-template.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '../dist');
await fs.writeFile(path.join(root,'BUILD_INFO.json'),JSON.stringify({edition:'public-ver1',engineVersion:'research-ver1',secondPane:'summary-2',sourceCommit:process.env.GITHUB_SHA||'local',builtAt:new Date().toISOString()},null,2));
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
await fs.writeFile(path.join(root, 'sw.js'), serviceWorkerSource(version, paths));
console.log(`Service worker: ${paths.length} shell assets; runtime cached only on explicit use.`);
