const MODEL_LOCK = 'research-tablet-heavy-model-v1';
const DEFAULT_TIMEOUTS = { load: 180_000, generate: 180_000, dispose: 30_000 };

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function aborted() {
  return new DOMException('요약 생성을 중단했습니다.', 'AbortError');
}

export function modelCapabilities(environment = globalThis) {
  const navigator = environment.navigator;
  return {
    webgpu: Boolean(navigator?.gpu),
    worker: typeof environment.Worker === 'function',
    locks: typeof navigator?.locks?.request === 'function',
    secureContext: environment.isSecureContext !== false,
  };
}

function defaultRuntimeUrl() {
  const base = import.meta.env?.BASE_URL ?? './';
  return new URL(`${base}runtime/`, globalThis.location?.href ?? import.meta.url).href;
}

/** A local-file-only model session. It owns the origin-wide lease until disposal. */
export class BrowserGenerator {
  constructor({
    onStatus = () => {},
    // LiteRT-LM's loader uses importScripts; it needs a classic, bundled worker.
    workerFactory = null,
    locks = globalThis.navigator?.locks,
    capabilities = () => modelCapabilities(),
    runtimeUrl = defaultRuntimeUrl(),
    timeouts = {},
  } = {}) {
    this.onStatus = onStatus;
    this.workerFactory = workerFactory ?? (() => new Worker(new URL('inference-worker.js', runtimeUrl)));
    this.locks = locks;
    this.capabilities = capabilities;
    this.runtimeUrl = runtimeUrl;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.worker = null;
    this.pending = new Map();
    this.nextId = 0;
    this._loaded = false;
    this._loading = false;
    this._broken = false;
    this._activeTask = null;
    this._activeId = null;
    this._disposeTask = null;
    this._releaseLease = null;
    this._leaseTask = null;
    this.maxContextTokens = 8192;
    this.model = null;
  }

  get loaded() { return this._loaded && !this._broken; }

  _status(state, message) {
    try { this.onStatus({ state, message }); }
    catch { /* UI observers must not alter the model lifecycle. */ }
  }

  async _acquireLease() {
    if (typeof this.locks?.request !== 'function') {
      throw failure('LOCKS_UNAVAILABLE', '이 브라우저는 모델 단일 점유를 지원하지 않습니다. 최신 Chrome 또는 Edge에서 사용해 주세요.');
    }
    await new Promise((resolve, reject) => {
      this._leaseTask = Promise.resolve(this.locks.request(MODEL_LOCK, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(failure('MODEL_IN_USE', '다른 탭에서 모델을 사용 중입니다. 그 탭의 모델을 해제한 뒤 다시 시도해 주세요.'));
          return;
        }
        await new Promise((release) => {
          this._releaseLease = release;
          resolve();
        });
      })).catch((error) => {
        reject(error?.code ? error : failure('LOCK_FAILED', '모델 점유를 확인하지 못했습니다. 페이지를 다시 열어 주세요.'));
      });
    });
  }

  async _release() {
    this._releaseLease?.();
    this._releaseLease = null;
    await this._leaseTask;
    this._leaseTask = null;
  }

  _breakRuntime(error) {
    this._broken = true;
    this._loaded = false;
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    // A missing SDK cleanup acknowledgment is not proof that GPU disposal completed.
    // Keep the lease until this document closes; do not start another model here.
    this._status('unavailable', '모델 정리를 확인할 수 없습니다. 이 탭을 닫고 다시 열어 주세요.');
  }

  _startWorker() {
    const worker = this.workerFactory();
    this.worker = worker;
    worker.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'status') {
        this._status(message.state, message.message);
        return;
      }
      const pending = this.pending.get(message?.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        const error = failure(message.error?.code ?? 'MODEL_ERROR', message.error?.message ?? '모델 처리에 실패했습니다.');
        if (message.error?.fatal) this._breakRuntime(error);
        pending.reject(error);
      }
    });
    worker.addEventListener('error', (event) => {
      event.preventDefault?.();
      this._breakRuntime(failure('WORKER_FAILED', '모델 작업이 예기치 않게 종료되었습니다.'));
    });
    worker.addEventListener('messageerror', () => this._breakRuntime(failure('WORKER_MESSAGE_FAILED', '모델과 데이터를 주고받지 못했습니다.')));
  }

  _call(type, payload = {}) {
    if (!this.worker || this._broken) {
      return { id: null, promise: Promise.reject(failure('RUNTIME_UNAVAILABLE', '모델을 사용할 수 없습니다. 이 탭을 다시 열어 주세요.')) };
    }
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._breakRuntime(failure('MODEL_TIMEOUT', '모델 응답 대기 시간이 지났습니다. 이 탭을 다시 열어 주세요.'));
      }, this.timeouts[type] ?? DEFAULT_TIMEOUTS.generate);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ type, id, ...payload });
      } catch {
        this._breakRuntime(failure('WORKER_MESSAGE_FAILED', '모델에 입력을 전달하지 못했습니다.'));
      }
    });
    return { id, promise };
  }

  async load({ file, maxContextTokens = 8192, signal } = {}) {
    if (signal?.aborted) throw aborted();
    if (this._loading || this.loaded || this._activeTask || this._disposeTask) {
      throw failure('MODEL_BUSY', '기존 모델을 해제한 뒤 새 모델을 선택해 주세요.');
    }
    if (this._broken) throw failure('RUNTIME_UNAVAILABLE', '모델 정리가 확인되지 않았습니다. 이 탭을 다시 열어 주세요.');
    if (!(file instanceof Blob) || !file.size || !String(file.name ?? '').toLowerCase().endsWith('.litertlm')) {
      throw failure('INVALID_MODEL', 'Web 호환 .litertlm 모델 파일을 선택해 주세요.');
    }
    if (!Number.isInteger(maxContextTokens) || maxContextTokens < 2048 || maxContextTokens > 32768) {
      throw failure('INVALID_CONTEXT', '모델 문맥 한도는 2,048~32,768 토큰 범위여야 합니다.');
    }
    const support = this.capabilities();
    if (!support.secureContext || !support.webgpu || !support.worker) {
      throw failure('WEBGPU_UNAVAILABLE', '이 브라우저에서는 로컬 AI를 실행할 수 없습니다. HTTPS의 WebGPU 지원 브라우저를 사용하거나 근거 발췌 모드로 진행해 주세요.');
    }
    this._loading = true;
    const onAbort = () => this._breakRuntime(aborted());
    this._status('loading', '선택한 모델을 이 기기에 불러오고 있습니다.');
    try {
      await this._acquireLease();
      if (signal?.aborted) { await this._release(); throw aborted(); }
      try {
        this._startWorker();
      } catch {
        await this._release();
        throw failure('WORKER_UNAVAILABLE', '모델 작업을 시작하지 못했습니다.');
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const result = await this._call('load', { file, maxContextTokens, runtimeUrl: this.runtimeUrl }).promise;
      this.maxContextTokens = maxContextTokens;
      this.model = { name: file.name, size: file.size, sdkVersion: '0.19.0', hash: null, ...result };
      this._loaded = true;
      this._status('ready', '로컬 모델 준비가 끝났습니다.');
      return this.model;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this._loading = false;
    }
  }

  async generate({ prompt, maxOutputTokens = 1200, signal } = {}) {
    if (signal?.aborted) throw aborted();
    if (!this.loaded) throw failure('MODEL_NOT_LOADED', '먼저 로컬 모델 파일을 불러와 주세요.');
    if (this._activeTask || this._disposeTask) throw failure('MODEL_BUSY', '앞선 모델 작업이 끝날 때까지 기다려 주세요.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 60_000) {
      throw failure('INVALID_PROMPT', '모델 입력이 비어 있거나 너무 깁니다.');
    }
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > Math.min(4096, this.maxContextTokens / 2)) {
      throw failure('INVALID_OUTPUT_LIMIT', '모델 출력 한도가 올바르지 않습니다.');
    }
    const { id, promise } = this._call('generate', { prompt, maxOutputTokens });
    this._activeId = id;
    let wasCancelled = false;
    const onAbort = () => { wasCancelled = true; this.cancel(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    this._status('generating', '원문 근거를 바탕으로 요약 후보를 만들고 있습니다.');
    this._activeTask = promise;
    try {
      const result = await promise;
      if (wasCancelled || result?.cancelled) throw aborted();
      if (typeof result?.text !== 'string' || !result.text.trim()) {
        throw failure('EMPTY_RESPONSE', '모델이 요약 후보를 만들지 못했습니다.');
      }
      return result.text;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this._activeTask = null;
      this._activeId = null;
      if (this.loaded) this._status('ready', '로컬 모델이 다음 작업을 기다립니다.');
    }
  }

  cancel() {
    if (this._activeId !== null && this.worker) {
      this.worker.postMessage({ type: 'cancel', targetId: this._activeId });
      this._status('cancelling', '중단 요청을 보냈습니다. 모델 정리가 끝날 때까지 기다립니다.');
    }
  }

  async dispose() {
    if (this._disposeTask) return this._disposeTask;
    if (this._loading) throw failure('MODEL_LOADING', '모델을 불러오는 중입니다. 완료 후 해제해 주세요.');
    if (this._broken) throw failure('RUNTIME_UNAVAILABLE', '모델 정리가 확인되지 않았습니다. 이 탭을 닫고 다시 열어 주세요.');
    if (!this.worker) { await this._release(); return; }
    this._disposeTask = (async () => {
      this.cancel();
      if (this._activeTask) await this._activeTask.catch(() => {});
      this._status('disposing', '모델을 해제하고 있습니다.');
      await this._call('dispose').promise;
      this.worker?.terminate();
      this.worker = null;
      this._loaded = false;
      this.model = null;
      await this._release();
      this._status('idle', '모델을 해제했습니다.');
    })();
    try { return await this._disposeTask; }
    finally { this._disposeTask = null; }
  }
}
