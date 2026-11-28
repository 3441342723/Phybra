import { SYSTEM_PROMPT } from './scene-prompt.ts';
import { SCENE_CONTRACT_REVISION } from './scene-contract.ts';
import { APP_SCOPE, InterpretError, extractDraft, messageContent, parseInterpretInput, type InterpretInput } from './interpret.ts';
import { draftDiagnostic, repairContent } from './draft-repair.ts';

// Owner-provided OpenAI-compatible endpoint. The key is a Sites Secret read only
// here in the Function runtime; it never reaches the browser or the prompt.
export const QWEN_BASE_URL = 'https://maas.qianwenaiapi.com/compatible-mode/v1';
// 供应商文档的模型调用 ID；展示名不是合法 model 参数（404）。单一模型间歇挂起，
// 按续取次数沿降级链切换（同端点同密钥）。
export const QWEN_MODEL_CHAIN = ['qwen3.8-flash', 'qwen3.7-plus', 'qwen4-max'];
export const QWEN_MODEL = QWEN_MODEL_CHAIN[0];
const MAX_REQUEST_BYTES = 1024 * 1024;
// Each GET executes at most one upstream call inside the platform request budget;
// intent/result live in private Storage so cold starts and retries stay durable.
const CALL_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 4;

function log(event: string, fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ event, ...fields }));
  } catch {
    // Diagnostics must never change request behavior.
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function openAiContent(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return blocks.map((block) => block.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:${(block.source as Record<string, unknown>).media_type};base64,${(block.source as Record<string, unknown>).data}` } }
    : { type: 'text', text: block.text });
}

function statusError(status: number): InterpretError {
  if (status === 401 || status === 403) return new InterpretError('ai_provider_denied', 503);
  if (status === 404) return new InterpretError('ai_model_unavailable', 503);
  if (status === 429) return new InterpretError('rate_limited', 429);
  if (status === 408 || status === 504) return new InterpretError('ai_timeout', 504);
  return new InterpretError('service_unavailable', 503);
}

async function readJsonContent(response: Response): Promise<string> {
  const data = await response.json().catch(() => null);
  const content = (data as any)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new InterpretError('ai_response_invalid', 502);
  return content;
}

async function readSseContent(response: Response): Promise<string> {
  if (!response.body) throw new InterpretError('ai_response_invalid', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return content;
        let event: any;
        try { event = JSON.parse(payload); } catch { continue; }
        if (event?.error) throw new InterpretError('ai_response_invalid', 502);
        const delta = event?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') content += delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return content;
}

export type QwenStore = {
  put: (path: string, bytes: Uint8Array) => Promise<unknown>;
  get: (path: string) => Promise<any | null>;
};

export type QwenProviderOptions = {
  fetchImpl?: typeof fetch;
  getKey?: () => string | undefined;
  callTimeoutMs?: number;
  now?: () => number;
  store: QwenStore;
};

type Intent = { text: string; image: InterpretInput['image']; attempts: number; repairAttempts: number };
type StoredResult =
  | { state: 'done'; draft: Record<string, unknown> }
  | { state: 'invalid'; reply: string; reason: string; diagnostic: string }
  | { state: 'failed'; code: string; status: number; diagnostic?: string; detail?: string };

export function createQwenProvider({
  fetchImpl = globalThis.fetch,
  getKey = () => (globalThis as any).Deno?.env?.get('QWEN_API_KEY'),
  callTimeoutMs = CALL_TIMEOUT_MS,
  now = Date.now,
  store,
}: QwenProviderOptions) {
  const intentPath = (jobId: string) => `qwen-jobs/${jobId}/intent.json`;
  const resultPath = (jobId: string) => `qwen-jobs/${jobId}/result.json`;
  const modelFor = (n: number) => QWEN_MODEL_CHAIN[Math.min(Math.max(0, n), QWEN_MODEL_CHAIN.length - 1)];
  const putJson = (path: string, value: unknown) => store.put(path, new TextEncoder().encode(JSON.stringify(value)));

  function enabled(): boolean {
    const key = getKey();
    return typeof key === 'string' && key.trim().length > 0 && !/[\r\n]/.test(key);
  }

  // Owner-only post-mortem in private Storage; browser and logs stay category-only.
  async function saveDebug(reply: string, reason: string): Promise<void> {
    try {
      await store.put(`qwen-debug/${now()}-${Math.random().toString(36).slice(2, 8)}.json`,
        new TextEncoder().encode(JSON.stringify({ reason, reply })));
    } catch {
      // Debug storage must never change request behavior.
    }
  }

  async function call(blocks: Array<Record<string, unknown>>, info: { hasImage: boolean; repair: boolean }, model: string): Promise<string> {
    const key = getKey();
    if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw new InterpretError('service_not_configured', 503);
    const body = JSON.stringify({ model, enable_thinking: false, stream: true, messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: openAiContent(blocks) },
    ] });
    if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) throw new InterpretError('payload_too_large', 413);
    const startedAt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callTimeoutMs);
    let upstreamStatus: number | undefined;
    try {
      const response = await fetchImpl(`${QWEN_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      upstreamStatus = response.status;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw statusError(response.status);
      }
      // Reseller gateways reset idle buffered responses; streaming keeps bytes flowing.
      const content = (response.headers.get('content-type') ?? '').includes('text/event-stream')
        ? await readSseContent(response)
        : await readJsonContent(response);
      if (!content.trim()) throw new InterpretError('ai_response_invalid', 502);
      log('qwen_done', { durationMs: Math.round(now() - startedAt), hasImage: info.hasImage, repair: info.repair, model });
      return content;
    } catch (error) {
      const failure = error instanceof InterpretError ? error
        : controller.signal.aborted ? new InterpretError('ai_timeout', 504)
        : new InterpretError('service_unavailable', 503);
      (failure as InterpretError & { upstreamStatus?: number; durationMs?: number }).upstreamStatus = upstreamStatus;
      (failure as InterpretError & { upstreamStatus?: number; durationMs?: number }).durationMs = Math.round(now() - startedAt);
      log('qwen_failed', { code: failure.code, durationMs: Math.round(now() - startedAt), repair: info.repair,
        ...(upstreamStatus !== undefined ? { upstreamStatus } : {}) });
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  async function start(body: unknown): Promise<Record<string, unknown>> {
    const { text, image, generationId } = parseInterpretInput(body);
    if (!enabled()) throw new InterpretError('service_not_configured', 503);
    const jobId = await digest(canonical({ scope: APP_SCOPE, contract: SCENE_CONTRACT_REVISION, provider: 'qwen',
      text, image: image?.base64 ?? null, ...(generationId ? { generationId } : {}) }));
    if (await store.get(intentPath(jobId))) {
      // 重提同题即用户主动重试：重置任何失败缓存（含换密钥前的旧错误），保留成功结果续取。
      const previous = await store.get(resultPath(jobId)) as StoredResult | null;
      if (previous?.state === 'failed') {
        const intent = await store.get(intentPath(jobId)) as Intent;
        await putJson(intentPath(jobId), { ...intent, attempts: 0, repairAttempts: 0 });
        await putJson(resultPath(jobId), null);
      }
      return { ok: true, jobId, resumed: true };
    }
    await putJson(intentPath(jobId), { text, image, attempts: 0, repairAttempts: 0 } satisfies Intent);
    log('qwen_accepted', { jobId, model: QWEN_MODEL, hasImage: Boolean(image), textChars: text.length });
    return { ok: true, jobId, resumed: false };
  }

  function failureResult(error: InterpretError): StoredResult {
    return { state: 'failed', code: error.code, status: error.status,
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      ...((error as InterpretError & { detail?: string }).detail ? { detail: (error as InterpretError & { detail?: string }).detail } : {}) };
  }

  function throwStored(result: StoredResult & { state: 'failed' }): never {
    const error = new InterpretError(result.code, result.status);
    if (result.diagnostic) error.diagnostic = result.diagnostic as any;
    if (result.detail) (error as InterpretError & { detail?: string }).detail = result.detail;
    throw error;
  }

  /** One GET executes at most one upstream call; durable state decides the phase. */
  async function result(jobId: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    if (typeof jobId !== 'string' || !/^[a-f0-9]{64}$/.test(jobId)) throw new InterpretError('invalid_job', 400);
    const stored = await store.get(resultPath(jobId)) as StoredResult | null;
    if (stored?.state === 'done') return { status: 200, body: stored.draft };
    if (stored?.state === 'failed') throwStored(stored);
    const intent = await store.get(intentPath(jobId)) as Intent | null;
    if (!intent) throw new InterpretError('job_not_found', 404);
    const source: Record<string, unknown> = intent.image?.name ? { imageName: intent.image.name } : {};
    const pending = (phase = 'generating') => ({ status: 202, body: { ok: true, pending: true, jobId, phase } });

    if (stored?.state === 'invalid') {
      const content = repairContent(messageContent(intent.text, intent.image), stored.reply, stored.reason);
      if (!content) {
        const failure = new InterpretError('ai_draft_invalid', 502, stored.reason);
        failure.diagnostic = stored.diagnostic as any;
        await saveDebug(stored.reply, stored.reason);
        await putJson(resultPath(jobId), failureResult(failure));
        throw failure;
      }
      let reply: string;
      try {
        reply = await call(content, { hasImage: Boolean(intent.image), repair: true }, modelFor(intent.repairAttempts ?? 0));
      } catch (error) {
        return settleCallError(jobId, intent, error, 'repairAttempts');
      }
      try {
        const draft = extractDraft(reply, source);
        const body = { ...draft, warnings: [...(draft.warnings as string[]), 'AI 草稿已自动修正一次格式，请核对题目条件后应用。'] };
        await putJson(resultPath(jobId), { state: 'done', draft: body });
        return { status: 200, body };
      } catch (error) {
        const failure = error instanceof InterpretError ? error : new InterpretError('ai_draft_invalid', 502);
        failure.diagnostic = draftDiagnostic(failure.code, failure.message);
        (failure as InterpretError & { detail?: string }).detail = failure.message.slice(0, 160);
        await saveDebug(reply, failure.message);
        await putJson(resultPath(jobId), failureResult(failure));
        throw failure;
      }
    }

    let reply: string;
    try {
      reply = await call(messageContent(intent.text, intent.image), { hasImage: Boolean(intent.image), repair: false }, modelFor(intent.attempts ?? 0));
    } catch (error) {
      return settleCallError(jobId, intent, error, 'attempts');
    }
    try {
      const draft = extractDraft(reply, source);
      await putJson(resultPath(jobId), { state: 'done', draft });
      log('qwen_result', { jobId });
      return { status: 200, body: draft };
    } catch (error) {
      const failure = error instanceof InterpretError ? error : new InterpretError('ai_draft_invalid', 502);
      const diagnostic = draftDiagnostic(failure.code, failure.message);
      await saveDebug(reply, failure.message);
      await putJson(resultPath(jobId), { state: 'invalid', reply, reason: failure.message, diagnostic });
      log('qwen_repair_started', { jobId, diagnostic });
      return pending('repairing');
    }
  }

  async function settleCallError(jobId: string, intent: Intent, error: unknown, counter: 'attempts' | 'repairAttempts'): Promise<{ status: number; body: Record<string, unknown> }> {
    const failure = error instanceof InterpretError ? error : new InterpretError('service_unavailable', 503);
    const attempts = (intent[counter] ?? 0) + 1;
    if (failure.code !== 'ai_timeout' || attempts >= MAX_ATTEMPTS) {
      if (failure.code === 'ai_timeout') failure.diagnostic = undefined;
      await putJson(resultPath(jobId), failureResult(failure));
      throw failure;
    }
    await putJson(intentPath(jobId), { ...intent, [counter]: attempts });
    return { status: 202, body: { ok: true, pending: true, jobId } };
  }

  return Object.freeze({ enabled, start, result });
}

export type QwenProvider = ReturnType<typeof createQwenProvider>;