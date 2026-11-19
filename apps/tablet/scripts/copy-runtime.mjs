import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.dirname(fileURLToPath(import.meta.resolve('@litert-lm/core/package.json')));
const packageInfo = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
if (packageInfo.version !== '0.19.0') throw new Error('LiteRT-LM must match the pinned 0.19.0 runtime.');
const utilsRoot = path.dirname(fileURLToPath(import.meta.resolve('@litertjs/wasm-utils/package.json')));
const utilsInfo = JSON.parse(await readFile(path.join(utilsRoot, 'package.json'), 'utf8'));
const source = path.join(packageRoot, 'wasm');
const destination = path.join(projectRoot, 'public', 'runtime');
await mkdir(destination, { recursive: true });
const files = (await readdir(source)).filter(name => /^litertlm_wasm_[a-z_]+\.(?:js|wasm)$/.test(name));
if (files.length < 8) throw new Error('The SDK runtime is incomplete. Run npm ci again.');
for (const name of files) await cp(path.join(source, name), path.join(destination, name));

// The published SDK's loader calls importScripts(), which is unavailable in
// module workers. Bundle the authored module as a classic IIFE for dev and build.
await build({
  configFile: false,
  root: projectRoot,
  publicDir: false,
  logLevel: 'warn',
  build: {
    target: 'es2022',
    outDir: destination,
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: path.join(projectRoot, 'src', 'model', 'inference.worker.js'),
      name: 'ResearchInferenceWorker',
      formats: ['iife'],
      fileName: () => 'inference-worker.js',
    },
  },
});

// These npm tarballs omit LICENSE, so retain the complete declared license
// locally instead of shipping only an external license URL. If a future
// package includes its own license, preserve that original file verbatim.
const canonicalApache = await readFile(path.join(projectRoot, 'licenses', 'Apache-2.0.txt'), 'utf8');
if (!canonicalApache.includes('END OF TERMS AND CONDITIONS') || !canonicalApache.includes('APPENDIX:')) {
  throw new Error('The complete Apache-2.0 distribution license is missing.');
}
const licenses = [];
for (const component of [
  { info: packageInfo, root: packageRoot, file: 'LICENSE-litert-lm-core.txt' },
  { info: utilsInfo, root: utilsRoot, file: 'LICENSE-litertjs-wasm-utils.txt' },
]) {
  if (component.info.license !== 'Apache-2.0') throw new Error(`Review the changed license for ${component.info.name}.`);
  let text = null;
  for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
    try { text = await readFile(path.join(component.root, name), 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(path.join(destination, component.file), text ?? canonicalApache);
  licenses.push({
    component: component.info.name,
    version: component.info.version,
    license: component.info.license,
    file: component.file,
    source: text === null ? 'tracked canonical Apache-2.0; npm tarball omits LICENSE' : 'original package LICENSE',
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const assets = [];
for (const name of [...files, 'inference-worker.js', ...licenses.map(item => item.file)]) {
  const file = path.join(destination, name);
  assets.push({ name, bytes: (await stat(file)).size, sha256: await sha256(file) });
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ sdk: '@litert-lm/core', version: packageInfo.version, licenses, assets }, null, 2));
await writeFile(path.join(destination, 'NOTICE.txt'), [
  `LiteRT-LM (@litert-lm/core ${packageInfo.version})`,
  'Copyright Google LLC and The ODML Authors.',
  'Source: https://github.com/google-ai-edge/LiteRT-LM',
  'Distributed under Apache-2.0; complete license: LICENSE-litert-lm-core.txt',
  '',
  `Includes @litertjs/wasm-utils ${utilsInfo.version}.`,
  'Source: https://github.com/google-ai-edge/LiteRT/tree/main/litert/js/packages/wasm_utils',
  'Distributed under Apache-2.0; complete license: LICENSE-litertjs-wasm-utils.txt',
  '',
  'Published SDK JS/WASM are copied without source modifications.',
  'The app integration is newly authored; inference-worker.js is an IIFE build of the integration and SDK imports.',
  'Model weights are not included. User-selected models have separate license terms.',
  '',
].join('\n'));
console.log(`Prepared local LiteRT-LM ${packageInfo.version}: ${assets.length} assets, ${assets.reduce((sum, asset) => sum + asset.bytes, 0)} bytes; no model weights downloaded.`);
