import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, refine } from '../src/core/summary/engine.js';
import { outboundSummary } from '../src/core/summary/output.js';
import { GoogleDriveConnector } from '../src/drive/google-drive.js';
import { syntheticResearch } from '../src/demo.js';

test('both summary stages and outbound copy work without Google configuration, OAuth, a model, or any network request', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Network is disabled for this test'); };
  try {
    const { text } = syntheticResearch();
    const first = await summarize(text);
    const second = await refine(first, { text });
    const output = outboundSummary(second).text;
    assert.deepEqual(first.report.engine.methodUsed, ['compressed-extractive']);
    assert.deepEqual(second.report.engine.methodUsed, ['compressed-extractive']);
    assert.ok(output.length > 0);
    assert.ok([...output].length <= Math.floor([...text].length / 3) && [...output].length < [...first.body].length);
    assert.equal(second.sourceHash, first.sourceHash);
    const drive = new GoogleDriveConnector({ clientId: '', apiKey: '', appId: '' });
    await assert.rejects(drive.connect());
    assert.equal(outboundSummary(second).text, output, 'missing Drive configuration cannot erase or alter a generated result');
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});
