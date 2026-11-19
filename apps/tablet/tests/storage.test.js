import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSettings, readSettings, writeSettings } from '../src/storage.js';

test('only public Google configuration can enter persistent settings', () => {
  let stored;
  const storage = { setItem: (_, value) => { stored = value; }, getItem: () => stored };
  writeSettings({ clientId: ' public-id ', apiKey: 'restricted-public-key', appId: '123', access_token: 'never-store', text: 'private source', maskingTerms: ['private name'] }, storage);
  assert.deepEqual(readSettings(storage), { clientId: 'public-id', apiKey: 'restricted-public-key', appId: '123' });
  assert.equal(stored.includes('never-store'), false);
  assert.equal(stored.includes('private'), false);
});

test('corrupt settings recover without adding arbitrary fields', () => {
  assert.deepEqual(readSettings({ getItem: () => '{broken' }), publicSettings());
});
