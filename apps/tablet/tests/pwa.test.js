import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('standalone PWA resolves launch and install icons inside the repository subpath', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../public/manifest.webmanifest', import.meta.url)));
  assert.equal(manifest.display, 'standalone');
  const root = new URL('https://example.github.io/prompt-token-saver/');
  assert.equal(new URL(manifest.start_url, root).href, root.href);
  assert.equal(new URL(manifest.scope, root).href, root.href);
  for (const expected of ['192x192', '512x512']) {
    const icon = manifest.icons.find(icon => icon.sizes === expected);
    assert.ok(icon);
    const data = await fs.readFile(new URL(`../public/${icon.src.replace(/^\.\//, '')}`, import.meta.url));
    assert.deepEqual([...data.subarray(0,8)], [137,80,78,71,13,10,26,10]);
    const size = Number(expected.split('x')[0]);
    assert.equal(data.readUInt32BE(16), size);
    assert.equal(data.readUInt32BE(20), size);
    assert.ok(new URL(icon.src, root).pathname.startsWith(root.pathname));
  }
  assert.match(manifest.icons.find(icon => icon.sizes === '512x512').purpose, /maskable/);
});

test('iOS home-screen icon has a real 180px PNG and the page declares standalone metadata', async () => {
  const png = await fs.readFile(new URL('../public/icons/apple-touch-icon.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 180);
  const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
});
