import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserGenerator, modelCapabilities } from '../src/model/generator.js';

class FakeLocks {
  held = false;
  async request(name, options, callback) {
    assert.equal(name, 'research-tablet-heavy-model-v1');
    assert.equal(options.ifAvailable, true);
    if (this.held) return callback(null);
    this.held = true;
    try { return await callback({ name }); }
    finally { this.held = false; }
  }
}

class FakeWorker {
  listeners = new Map();
  messages = [];
  terminated = false;
  autoGenerate = true;
  autoLoad = true;
  autoDispose = true;
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, data) {
    for (const listener of this.listeners.get(type) ?? []) listener(type === 'message' ? { data } : { preventDefault() {} });
  }
  respond(message, result) { this.emit('message', { id: message.id, ok: true, result }); }
  postMessage(message) {
    this.messages.push(message);
    if (message.type === 'load' && this.autoLoad) queueMicrotask(() => this.respond(message, { source: 'local_file', contextTokens: 8192 }));
    if (message.type === 'generate' && this.autoGenerate) queueMicrotask(() => this.respond(message, { text: '원문에 근거한 후보입니다.', cancelled: false }));
    if (message.type === 'dispose' && this.autoDispose) queueMicrotask(() => this.respond(message, { disposed: true }));
  }
  terminate() { this.terminated = true; }
}

const support = () => ({ webgpu: true, worker: true, locks: true, secureContext: true });
const modelFile = () => new File(['synthetic container, never actually loaded'], 'synthetic.litertlm');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const locks = options.locks ?? new FakeLocks();
  const worker = options.worker ?? new FakeWorker();
  const statuses = [];
  const generator = new BrowserGenerator({
    onStatus: status => statuses.push(status),
    workerFactory: () => worker,
    capabilities: support,
    locks,
    runtimeUrl: 'https://example.test/repository/runtime/',
    ...options,
  });
  return { generator, worker, locks, statuses };
}

test('capabilities report missing GPU/Worker/locks instead of claiming support', () => {
  assert.deepEqual(modelCapabilities({ navigator: {}, isSecureContext: false }), {
    webgpu: false, worker: false, locks: false, secureContext: false,
  });
});

test('local-file load uses same-origin runtime and holds lease until acknowledged disposal', async () => {
  const { generator, worker, locks } = harness();
  const model = await generator.load({ file: modelFile() });
  assert.equal(generator.loaded, true);
  assert.equal(model.source, 'local_file');
  assert.equal(model.hash, null);
  assert.equal(locks.held, true);
  assert.equal(worker.messages[0].runtimeUrl, 'https://example.test/repository/runtime/');
  assert.ok(worker.messages[0].file instanceof File);
  assert.equal(await generator.generate({ prompt: '지어낸 합성 근거만 요약' }), '원문에 근거한 후보입니다.');
  worker.autoDispose = false;
  const disposing = generator.dispose();
  await tick();
  assert.equal(locks.held, true);
  assert.equal(worker.terminated, false);
  worker.respond(worker.messages.find(message => message.type === 'dispose'), { disposed: true });
  await disposing;
  assert.equal(locks.held, false);
  assert.equal(worker.terminated, true);
  assert.equal(generator.loaded, false);
});

test('invalid file or unavailable device never obtains a lease or creates a model', async () => {
  const { generator, worker, locks } = harness();
  await assert.rejects(generator.load({ file: new File(['x'], 'model.task') }), { code: 'INVALID_MODEL' });
  assert.equal(worker.messages.length, 0);
  assert.equal(locks.held, false);
  const unavailable = harness({ capabilities: () => ({ webgpu: false, worker: true, secureContext: true }) });
  await assert.rejects(unavailable.generator.load({ file: modelFile() }), { code: 'WEBGPU_UNAVAILABLE' });
  assert.equal(unavailable.locks.held, false);
});

test('a second tab cannot load while the first tab owns the origin model lease', async () => {
  const locks = new FakeLocks();
  const first = harness({ locks });
  const second = harness({ locks });
  await first.generator.load({ file: modelFile() });
  await assert.rejects(second.generator.load({ file: modelFile() }), { code: 'MODEL_IN_USE' });
  assert.equal(second.worker.messages.length, 0);
  await first.generator.dispose();
  await second.generator.load({ file: modelFile() });
  assert.equal(second.generator.loaded, true);
  await second.generator.dispose();
});

test('cancellation waits for worker cleanup acknowledgment and does not free model lease', async () => {
  const { generator, worker, locks } = harness();
  worker.autoGenerate = false;
  await generator.load({ file: modelFile() });
  const controller = new AbortController();
  const generated = generator.generate({ prompt: '합성 원문', signal: controller.signal });
  const rejection = assert.rejects(generated, { name: 'AbortError' });
  const generationMessage = worker.messages.find(message => message.type === 'generate');
  controller.abort();
  assert.equal(worker.messages.at(-1).type, 'cancel');
  assert.equal(worker.messages.at(-1).targetId, generationMessage.id);
  assert.equal(locks.held, true);
  await assert.rejects(generator.generate({ prompt: '동시에 실행하면 안 됨' }), { code: 'MODEL_BUSY' });
  worker.respond(generationMessage, { text: '', cancelled: true });
  await rejection;
  assert.equal(locks.held, true);
  await generator.dispose();
  assert.equal(locks.held, false);
});

test('dispose first cancels and waits for actual generation completion', async () => {
  const { generator, worker, locks } = harness();
  worker.autoGenerate = false;
  await generator.load({ file: modelFile() });
  const generation = generator.generate({ prompt: '긴 합성 원문' });
  const rejection = assert.rejects(generation, { name: 'AbortError' });
  const disposing = generator.dispose();
  await tick();
  assert.equal(worker.messages.some(message => message.type === 'dispose'), false);
  assert.equal(locks.held, true);
  worker.respond(worker.messages.find(message => message.type === 'generate'), { text: '', cancelled: true });
  await rejection;
  await disposing;
  assert.equal(locks.held, false);
});

test('worker crash fails closed and never returns the unconfirmed model slot', async () => {
  const { generator, worker, locks } = harness();
  await generator.load({ file: modelFile() });
  worker.emit('error');
  assert.equal(generator.loaded, false);
  assert.equal(worker.terminated, true);
  assert.equal(locks.held, true);
  await assert.rejects(generator.dispose(), { code: 'RUNTIME_UNAVAILABLE' });
  await assert.rejects(generator.load({ file: modelFile() }), { code: 'RUNTIME_UNAVAILABLE' });
});

test('fatal SDK cleanup failure is not a successful generation or released lease', async () => {
  const { generator, worker, locks } = harness();
  worker.autoGenerate = false;
  await generator.load({ file: modelFile() });
  const generated = generator.generate({ prompt: '합성 입력' });
  const rejection = assert.rejects(generated, { code: 'MODEL_CLEANUP_FAILED' });
  const id = worker.messages.at(-1).id;
  worker.emit('message', { id, ok: false, error: { code: 'MODEL_CLEANUP_FAILED', message: '정리 실패', fatal: true } });
  await rejection;
  assert.equal(locks.held, true);
  assert.equal(generator.loaded, false);
});

test('bounded load timeout terminates worker and requires tab restart', async () => {
  const worker = new FakeWorker();
  worker.autoLoad = false;
  const { generator, locks } = harness({ worker, timeouts: { load: 15 } });
  await assert.rejects(generator.load({ file: modelFile() }), { code: 'MODEL_TIMEOUT' });
  assert.equal(worker.terminated, true);
  assert.equal(locks.held, true);
  assert.equal(generator.loaded, false);
});

test('load cancellation terminates the loader and does not claim GPU cleanup', async () => {
  const worker = new FakeWorker();
  worker.autoLoad = false;
  const { generator, locks } = harness({ worker });
  const controller = new AbortController();
  const loading = generator.load({ file: modelFile(), signal: controller.signal });
  const rejection = assert.rejects(loading, { name: 'AbortError' });
  await tick();
  controller.abort();
  await rejection;
  assert.equal(worker.terminated, true);
  assert.equal(locks.held, true);
});

test('already-aborted input never starts a request or opens a GPU session', async () => {
  const { generator, worker, locks } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generator.load({ file: modelFile(), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(worker.messages.length, 0);
  assert.equal(locks.held, false);
});
