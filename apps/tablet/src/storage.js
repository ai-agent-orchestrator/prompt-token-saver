const DB_NAME = 'ieo-research-tablet-v1';
const SETTINGS_KEY = 'ieo-public-settings-v1';
const PUBLIC_FIELDS = ['clientId', 'apiKey', 'appId'];

export function publicSettings(input = {}) {
  return Object.fromEntries(PUBLIC_FIELDS.map(key => [key, String(input[key] || '').trim().slice(0, 500)]));
}

export function readSettings(storage) {
  try { return publicSettings(JSON.parse((storage || globalThis.localStorage).getItem(SETTINGS_KEY) || '{}')); }
  catch { return publicSettings(); }
}

export function writeSettings(input, storage) {
  const settings = publicSettings(input);
  (storage || globalThis.localStorage).setItem(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

export class RecoveryStore {
  constructor(indexedDB) { this.indexedDB = indexedDB; }
  async open() {
    try { this.indexedDB ||= globalThis.indexedDB; } catch { /* Report blocked storage without breaking Core. */ }
    if (!this.indexedDB) throw new Error('이 브라우저에서는 작업 복구 보관을 사용할 수 없습니다.');
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('runs', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('작업 보관함을 열 수 없습니다. 브라우저 저장 공간을 확인해 주세요.'));
      request.onblocked = () => reject(new Error('다른 탭의 작업 보관함을 닫은 뒤 다시 시도해 주세요.'));
    });
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }
  async transact(mode, operation) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('runs', mode);
      let result;
      const request = operation(transaction.objectStore('runs'));
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(new Error('작업을 보관하지 못했습니다. 저장 공간이 부족하거나 접근이 제한되었습니다.'));
    });
  }
  async put(run) {
    // Only the research run is persisted. OAuth tokens, model files, and personal masking dictionaries stay in memory.
    return this.transact('readwrite', store => store.put(structuredClone(run)));
  }
  async list() {
    const runs = await this.transact('readonly', store => store.getAll());
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async clear() { return this.transact('readwrite', store => store.clear()); }
}
