import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeResearch, refineResearch, buildArtifacts } from '../src/core/research.js';
import { GoogleDriveConnector } from '../src/drive/google-drive.js';
import { syntheticResearch } from '../src/demo.js';

test('both summary stages and outbound copy work without Google configuration, OAuth, a model, or any network request', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Network is disabled for this test'); };
  try {
    const first = await analyzeResearch({ ...syntheticResearch(), mode: 'expanded' });
    const second = await refineResearch(first);
    const output = buildArtifacts(second)[0].text;
    assert.equal(first.generatorUsed, false);
    assert.equal(second.generatorUsed, false);
    assert.ok(output.length > 0);
    assert.match(output, /분관 운영 중단일/);
    assert.equal(second.source.textHash, first.source.textHash);
    const drive = new GoogleDriveConnector({ clientId: '', apiKey: '', appId: '' });
    await assert.rejects(drive.connect());
    assert.equal(buildArtifacts(second)[0].text, output, 'missing Drive configuration cannot erase or alter a generated result');
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});
