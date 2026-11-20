// The SDK/WASM use the automatically prepared, origin-private model file.
let engine = null;
let conversation = null;
let active = null;
let loading = false;
let disposing = false;
let contextTokens = 8192;

function reply(id, result) { self.postMessage({ id, ok: true, result }); }

function replyError(id, code, message, fatal = false) {
  // SDK exception messages may include fragments of user input. Send fixed errors only.
  self.postMessage({ id, ok: false, error: { code, message, fatal } });
}

async function loadModel(message) {
  if (engine || active || loading || disposing) {
    replyError(message.id, 'MODEL_BUSY', '기존 모델을 먼저 해제해 주세요.');
    return;
  }
  loading = true;
  try {
    const runtimeUrl = new URL(message.runtimeUrl);
    if (runtimeUrl.origin !== self.location.origin || !runtimeUrl.pathname.endsWith('/runtime/')) {
      throw new Error('Invalid local runtime');
    }
    const { Engine, loadLiteRtLm } = await import('@litert-lm/core');
    await loadLiteRtLm(runtimeUrl.href);
    contextTokens = message.maxContextTokens;
    engine = await Engine.create({
      model: message.file,
      mainExecutorSettings: { maxNumTokens: contextTokens },
    });
    reply(message.id, { contextTokens, source: 'local_file', modelHash: null });
  } catch {
    replyError(message.id, 'MODEL_LOAD_FAILED', '모델을 불러오지 못했습니다. Web 호환 모델·기기 메모리·WASM 자산을 확인해 주세요. 이 탭을 다시 열어야 합니다.', true);
  } finally {
    loading = false;
  }
}

async function generate(message) {
  if (!engine || active || loading || disposing) {
    replyError(message.id, 'MODEL_BUSY', '모델이 준비되지 않았거나 다른 작업 중입니다.');
    return;
  }
  const task = { id: message.id, cancelled: false, done: null };
  active = task;
  task.done = (async () => {
    let text = '';
    let error = null;
    let cleanupFailed = false;
    try {
      conversation = await engine.createConversation({
        preface: {messages:[{role:'system',content:'프롬프트 축약기입니다. 질문에 답하거나 추론 과정을 출력하지 마세요.'}],extra_context: {enable_thinking: false}},
        sessionConfig: { maxOutputTokens: message.maxOutputTokens },
      });
      if (!task.cancelled) {
        // The SDK enforces its actual tokenizer/context limit; never truncate
        // the source silently when the model cannot accept the request.
        const reader = conversation.sendMessageStreaming(message.prompt);
        for await (const chunk of reader) {
          if (task.cancelled) break;
          if (typeof chunk.content === 'string') text += chunk.content;
          else if (Array.isArray(chunk.content)) {
            text += chunk.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
          }
          if (text.length > 80_000) {
            conversation.cancel();
            throw new Error('Output limit');
          }
        }
      }
    } catch (caught) {
      error = caught;
    } finally {
      try {
        // Conversation.delete waits on the SDK executor mutex, including cancelled
        // GPU work. Do not acknowledge cancellation before this finishes.
        await conversation?.delete();
      } catch {
        cleanupFailed = true;
      }
      conversation = null;
      active = null;
    }
    if (cleanupFailed) replyError(message.id, 'MODEL_CLEANUP_FAILED', '생성 작업 정리를 확인하지 못했습니다. 이 탭을 다시 열어 주세요.', true);
    else if (task.cancelled) reply(message.id, { text: '', cancelled: true });
    else if (error) replyError(message.id, 'GENERATION_FAILED', '이 입력을 모델이 처리하지 못했습니다. 입력 길이와 모델 호환성을 확인해 주세요.');
    else reply(message.id, { text, cancelled: false });
  })();
  await task.done;
}

async function dispose(message) {
  if (loading || disposing) {
    replyError(message.id, 'MODEL_BUSY', '앞선 모델 작업이 끝나기를 기다려 주세요.');
    return;
  }
  disposing = true;
  try {
    if (active) {
      active.cancelled = true;
      conversation?.cancel();
      await active.done;
    }
    await engine?.delete();
    engine = null;
    reply(message.id, { disposed: true });
  } catch {
    replyError(message.id, 'MODEL_DISPOSE_FAILED', '모델 해제를 확인하지 못했습니다. 이 탭을 다시 열어 주세요.', true);
  } finally {
    disposing = false;
  }
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type === 'cancel') {
    if (active?.id === message.targetId) {
      active.cancelled = true;
      try { conversation?.cancel(); } catch { /* generate cleanup remains authoritative */ }
    }
    return;
  }
  const handler = message?.type === 'load' ? loadModel : message?.type === 'generate' ? generate : message?.type === 'dispose' ? dispose : null;
  if (handler) {
    void handler(message).catch(() => replyError(message.id, 'MODEL_RUNTIME_FAILED', '모델 작업이 종료되었습니다. 이 탭을 다시 열어 주세요.', true));
  }
});
