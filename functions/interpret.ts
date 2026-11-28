import { SYSTEM_PROMPT, SCENE_CONTRACT_REVISION } from './scene-prompt.ts';
import { validateSceneDraft, DraftContractError } from './draft-schema.ts';
import { draftDiagnostic, repairContent, unfinishedJson, type DraftDiagnostic } from './draft-repair.ts';

// Trusted server-only configuration. The origin is copied from the Sites runtime
// context (get_context.runtime.cloudAgents.apiOrigin); QODER_PAT is read only by the
// QCA client inside the Function runtime and never appears here.
export const CLOUD_API_ORIGIN = 'https://api.qoder.com.cn';
export const CLOUD_REQUEST_TIMEOUT_MS = 12000;

export const APP_SCOPE = 'physics-workbench-p3-1';
const PURPOSE = 'scene-interpret';
const MAX_TEXT_CHARS = 8000;
const MAX_IMAGE_BYTES = 600 * 1024;
// The Sites gateway drops a request at about 100 s, so no single call may wait for
// the model. Start returns 202 immediately; the browser polls the result endpoint.
const RESULT_READ_BUDGET_MS = 10000;
const JOB_STALE_MS = 10 * 60 * 1000;
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class InterpretError extends Error {
  status: number;
  code: string;
  diagnostic?: DraftDiagnostic;
  constructor(code: string, status: number, message?: string, diagnostic?: DraftDiagnostic) {
    super(message ?? code);
    this.code = code;
    this.status = status;
    this.diagnostic = diagnostic;
  }
}

type CloudClient = {
  request: (path: string, options?: { method?: string; body?: unknown; idempotencyKey?: string }) => Promise<any>;
  findResources: (kind: string, metadata: Record<string, string>) => Promise<Array<Record<string, unknown>>>;
};

// Owner-visible runtime diagnostics only: resource ids, event type names and counters.
// Never log prompt text, model output, upstream bodies or credentials.
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

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function firstBytes(base64: string, count: number): Uint8Array {
  const raw = atob(base64.slice(0, Math.ceil((count * 4) / 3)));
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count && i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sniffMediaType(base64: string): string | null {
  const head = firstBytes(base64, 16);
  const text = Array.from(head.slice(0, 4), (byte) => String.fromCharCode(byte)).join('');
  if (head[0] === 0x89 && text.slice(1, 4) === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif';
  if (text === 'RIFF' && Array.from(head.slice(8, 12), (byte) => String.fromCharCode(byte)).join('') === 'WEBP') return 'image/webp';
  return null;
}

const EXTENSIONS: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export type InterpretInput = {
  text: string;
  image: { base64: string; mediaType: string; name: string } | null;
  generationId?: string;
};

export function parseInterpretInput(body: unknown): InterpretInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new InterpretError('invalid_payload', 400);
  const input = body as Record<string, unknown>;
  if (input.generationId !== undefined && (typeof input.generationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.generationId))) {
    throw new InterpretError('invalid_generation_id', 400);
  }
  const generation = typeof input.generationId === 'string' ? { generationId: input.generationId } : {};
  if (typeof input.text !== 'string') throw new InterpretError('invalid_text', 400);
  const text = input.text.trim();
  if (!text) throw new InterpretError('invalid_text', 400, 'text is empty');
  if (text.length > MAX_TEXT_CHARS) throw new InterpretError('text_too_large', 413);
  if (input.imageName !== undefined && typeof input.imageName !== 'string') throw new InterpretError('invalid_image_name', 400);
  const imageName = typeof input.imageName === 'string' ? input.imageName.slice(0, 200) : '';
  if (input.imageBase64 === undefined || input.imageBase64 === null || input.imageBase64 === '') return { text, image: null, ...generation };
  if (typeof input.imageBase64 !== 'string' || !base64Pattern.test(input.imageBase64) || input.imageBase64.length % 4 === 1) {
    throw new InterpretError('invalid_image_base64', 400);
  }
  const size = decodedByteLength(input.imageBase64);
  if (size > MAX_IMAGE_BYTES) throw new InterpretError('image_too_large', 413, `decoded image is ${size} bytes`);
  const extension = /(?:\.)([A-Za-z0-9]+)$/.exec(imageName)?.[1]?.toLowerCase() ?? '';
  // Trust the bytes, not a user-controlled filename. An optional known
  // extension may narrow the accepted type, but it must agree with the magic
  // bytes so a text payload named `photo.png` cannot reach Cloud Agents.
  const detectedType = sniffMediaType(input.imageBase64);
  const namedType = MEDIA_TYPES.has(EXTENSIONS[extension]) ? EXTENSIONS[extension] : null;
  if (!detectedType || (namedType && namedType !== detectedType)) {
    throw new InterpretError('unsupported_image_type', 415);
  }
  const mediaType = detectedType;
  return { text, image: { base64: input.imageBase64, mediaType, name: imageName }, ...generation };
}

const inFlight = new Map<string, Promise<Record<string, unknown>>>();

async function ensureResource(
  client: CloudClient,
  kind: 'agents' | 'environments',
  definition: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fingerprint = (await digest(canonical(definition))).slice(0, 32);
  const key = `${APP_SCOPE}:${kind}:${fingerprint}`;
  const metadata = { app: APP_SCOPE, purpose: PURPOSE, config: fingerprint };
  const pending = inFlight.get(key);
  if (pending) return pending;
  const task = (async () => {
    const matches = await client.findResources(kind, metadata);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new InterpretError('ai_resource_ambiguous', 503);
    const created = await client.request(`/api/v1/cloud/${kind}`, {
      method: 'POST',
      body: { ...definition, metadata },
      idempotencyKey: `sites-${kind}-${key}`,
    });
    if (typeof created?.id !== 'string') throw new InterpretError('ai_response_invalid', 502);
    return created as Record<string, unknown>;
  })();
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (inFlight.get(key) === task) inFlight.delete(key);
  }
}

function collectText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text'
      && typeof (block as Record<string, unknown>).text === 'string')
    .map((block) => (block as Record<string, unknown>).text as string)
    .join('\n');
}

function stripToFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

export function extractDraft(text: string, source: Record<string, unknown>): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripToFences(text));
  } catch {
    throw new InterpretError('ai_draft_unparseable', 502);
  }
  // source is taken from the trusted request, never from the model reply.
  const candidate = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...parsed as Record<string, unknown>, source }
    : parsed;
  try {
    return validateSceneDraft(candidate);
  } catch (error) {
    const reason = error instanceof DraftContractError ? error.message.slice(0, 160) : 'unknown';
    throw new InterpretError('ai_draft_invalid', 502, reason, draftDiagnostic('ai_draft_invalid', reason));
  }
}

const MAX_EVENT_PAGES = 20;
const MAX_SESSION_PAGES = 10;

// A long session produces more than one page of events; reading only the first
// page would never reach the final answer.
async function readEventTexts(
  client: CloudClient,
  sessionId: string,
  deadline: number,
  typeCounts: Map<string, number>,
): Promise<{ texts: string[]; hasMore: boolean; original: Array<Record<string, unknown>> }> {
  const texts: string[] = [];
  let original: Array<Record<string, unknown>> = [];
  let page: string | undefined;
  let hasMore = false;
  for (let index = 0; index < MAX_EVENT_PAGES && Date.now() < deadline; index += 1) {
    const query = `/api/v1/cloud/sessions/${sessionId}/events?order=asc&limit=100${page ? `&page=${encodeURIComponent(page)}` : ''}`;
    const result = await client.request(query);
    for (const event of (Array.isArray(result?.data) ? result.data : [])) {
      const type = typeof event?.type === 'string' ? event.type : 'unknown';
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
      if (type === 'user.message' && !original.length && Array.isArray(event.content)) {
        original = event.content.filter((block: Record<string, unknown>) => block?.type === 'text' || block?.type === 'image');
      }
      if (type !== 'agent.message') continue;
      const text = collectText(event.content);
      if (text.length > 0) texts.push(text);
    }
    hasMore = result?.has_more === true;
    if (!hasMore || typeof result?.next_page !== 'string' || !result.next_page) break;
    page = result.next_page;
  }
  return { texts, hasMore, original };
}

function jobFingerprint(text: string, image: InterpretInput['image'], generationId?: string): Promise<string> {
  return digest(canonical({ scope: APP_SCOPE, contract: SCENE_CONTRACT_REVISION, text, image: image?.base64 ?? null, ...(generationId ? { generationId } : {}) }));
}

// Sessions carry the job fingerprint in metadata; the list API has no metadata
// filter, so scan recent pages and match exactly one.
async function findJobSession(client: CloudClient, jobId: string): Promise<Record<string, unknown> | null> {
  let page: string | undefined;
  const matches = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < MAX_SESSION_PAGES; index += 1) {
    const result = await client.request(`/api/v1/cloud/sessions?limit=100&order=desc${page ? `&page=${encodeURIComponent(page)}` : ''}`);
    for (const session of (Array.isArray(result?.data) ? result.data : [])) {
      if (session && typeof session === 'object' && typeof session.id === 'string'
        && !session.archived_at && session.metadata?.job === jobId) {
        matches.set(session.id, session);
      }
    }
    if (result?.has_more !== true || typeof result?.next_page !== 'string' || !result.next_page) break;
    page = result.next_page;
  }
  if (matches.size > 1) throw new InterpretError('ai_resource_ambiguous', 503);
  return matches.size === 1 ? [...matches.values()][0] : null;
}

async function hasUserMessage(client: CloudClient, sessionId: string): Promise<boolean> {
  const result = await client.request(`/api/v1/cloud/sessions/${sessionId}/events?order=asc&limit=100`);
  return (Array.isArray(result?.data) ? result.data : [])
    .some((event: Record<string, unknown>) => event?.type === 'user.message');
}

export function messageContent(text: string, image: InterpretInput['image']): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: image ? `${text}\n\n（随题附题图一张，题面数值以文字与图中标注为准。）` : text },
  ];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });
  return content;
}

const startingJobs = new Map<string, Promise<Record<string, unknown>>>();

/** Accept a problem: reuse or create the cloud session, send the prompt once, return immediately. */
export async function startInterpret(client: CloudClient, body: unknown): Promise<Record<string, unknown>> {
  const { text, image, generationId } = parseInterpretInput(body);
  const jobId = await jobFingerprint(text, image, generationId);
  return startJob(client, jobId, messageContent(text, image), { text, hasImage: Boolean(image), imageName: image?.name });
}

async function startJob(client: CloudClient, jobId: string, content: Array<Record<string, unknown>>, info: {
  text: string; hasImage: boolean; imageName?: string; repairOf?: string;
}): Promise<Record<string, unknown>> {
  const pending = startingJobs.get(jobId);
  if (pending) return pending;
  const task = (async () => {
    const existing = await findJobSession(client, jobId);
    if (existing && typeof existing.id === 'string') {
      // A previous start may have crashed between session creation and prompt send.
      if (!(await hasUserMessage(client, existing.id))) {
        await client.request(`/api/v1/cloud/sessions/${existing.id}/events`, {
          method: 'POST',
          body: { events: [{ type: 'user.message', content }] },
          idempotencyKey: `sites-prompt-${jobId}`,
        });
      }
      log('interpret_resumed', { jobId, sessionId: existing.id });
      return { ok: true, jobId, resumed: true };
    }

    const models = await client.request('/api/v1/cloud/models');
    const enabled: string[] = (Array.isArray(models?.data) ? models.data : [])
      .filter((model: Record<string, unknown>) => model?.is_enabled === true && typeof model?.id === 'string')
      .map((model: Record<string, unknown>) => model.id as string)
      .sort();
    // 'auto' is a console routing alias: sessions created with it stay running and
    // never emit agent.message (observed in runtime logs 2026-11-27), so pin a real model.
    const concrete = enabled.filter((id) => id !== 'auto');
    if (!concrete.length) {
      const raw = Array.isArray(models?.data) ? models.data : [];
      log('interpret_models_unavailable', { rawCount: Array.isArray(models?.data) ? raw.length : null, enabledCount: enabled.length,
        sample: raw.slice(0, 3).map((m: Record<string, unknown>) => ({ id: typeof m?.id === 'string' ? m.id : null, keys: m && typeof m === 'object' ? Object.keys(m).slice(0, 12) : [] })) });
      throw new InterpretError('ai_model_unavailable', 503);
    }
    const model = concrete.includes('fast') ? 'fast' : concrete[0];
    log('interpret_start', { jobId, model, enabledModels: enabled.slice(0, 20), hasImage: info.hasImage, textChars: info.text.length });

    const agent = await ensureResource(client, 'agents', {
      name: '物理读题建模器',
      model,
      system: SYSTEM_PROMPT,
      tools: [],
      metadata: { app: APP_SCOPE, purpose: PURPOSE },
    });
    const environment = await ensureResource(client, 'environments', {
      name: '物理读题建模器运行环境',
      config: { type: 'cloud' },
      metadata: { app: APP_SCOPE, purpose: PURPOSE },
    });
    if (typeof agent.id !== 'string' || !Number.isInteger(agent.version)) throw new InterpretError('ai_response_invalid', 502);
    if (typeof environment.id !== 'string') throw new InterpretError('ai_response_invalid', 502);

    const session = await client.request('/api/v1/cloud/sessions', {
      method: 'POST',
      body: {
        agent: { type: 'agent', id: agent.id, version: agent.version },
        environment_id: environment.id,
        title: `读题 ${info.text.slice(0, 40)}`,
        metadata: { app: APP_SCOPE, purpose: PURPOSE, job: jobId, ...(info.imageName ? { imageName: info.imageName } : {}), ...(info.repairOf ? { repairOf: info.repairOf } : {}) },
      },
      idempotencyKey: `sites-session-${APP_SCOPE}-${jobId}`,
    });
    if (typeof session?.id !== 'string') throw new InterpretError('ai_response_invalid', 502);

    await client.request(`/api/v1/cloud/sessions/${session.id}/events`, {
      method: 'POST',
      body: { events: [{ type: 'user.message', content }] },
      idempotencyKey: `sites-prompt-${jobId}`,
    });
    log('interpret_accepted', { jobId, sessionId: session.id, model });
    return { ok: true, jobId, resumed: false };
  })();
  startingJobs.set(jobId, task);
  try {
    return await task;
  } finally {
    if (startingJobs.get(jobId) === task) startingJobs.delete(jobId);
  }
}

function createdAtMs(session: Record<string, unknown>): number | null {
  const raw = session.created_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Poll one job: return the validated draft, a pending marker, or a stable failure. */
export async function interpretResult(client: CloudClient, jobId: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof jobId !== 'string' || !/^[a-f0-9]{64}$/.test(jobId)) throw new InterpretError('invalid_job', 400);
  return readJobResult(client, jobId, true);
}

async function readJobResult(client: CloudClient, jobId: string, allowRepair: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const session = await findJobSession(client, jobId);
  if (!session || typeof session.id !== 'string') throw new InterpretError('job_not_found', 404);

  const typeCounts = new Map<string, number>();
  const { texts, hasMore, original } = await readEventTexts(client, session.id, Date.now() + RESULT_READ_BUDGET_MS, typeCounts);
  const source: Record<string, unknown> = {};
  const metadata = session.metadata as Record<string, unknown> | undefined;
  if (typeof metadata?.imageName === 'string') source.imageName = metadata.imageName;
  const createdAt = createdAtMs(session);
  const stale = createdAt !== null && Date.now() - createdAt > JOB_STALE_MS;
  const pending = (phase = 'generating') => ({ status: 202, body: { ok: true, pending: true, jobId, phase } });
  if (hasMore) {
    if (stale) throw new InterpretError('ai_timeout', 504);
    return pending();
  }

  let lastFailure: InterpretError | null = null;
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    try {
      const draft = extractDraft(texts[index], source);
      log('interpret_done', { jobId, sessionId: session.id });
      return { status: 200, body: draft };
    } catch (error) {
      if (error instanceof InterpretError) lastFailure = error;
    }
  }
  // A streamed answer can be split across several agent.message events.
  if (texts.length > 1) {
    try {
      const draft = extractDraft(texts.join(''), source);
      log('interpret_done', { jobId, sessionId: session.id });
      return { status: 200, body: draft };
    } catch (error) {
      if (error instanceof InterpretError) lastFailure = error;
    }
  }
  if (texts.length > 0 && lastFailure) {
    // agent.message can contain a partial JSON stream. Never reject or repair it
    // while brackets/strings are unfinished; another poll may finish the reply.
    if (lastFailure.code === 'ai_draft_unparseable' && unfinishedJson(texts.join(''))) {
      if (stale) throw new InterpretError('ai_timeout', 504);
      return pending();
    }
    if (allowRepair) {
      const content = repairContent(original, texts.join(''), lastFailure.message);
      if (content) {
        const repairId = await digest(canonical({ jobId, contract: SCENE_CONTRACT_REVISION, attempt: 1 }));
        const accepted = await startJob(client, repairId, content, {
          text: '修正草稿格式', hasImage: original.some(block => block.type === 'image'),
          imageName: typeof metadata?.imageName === 'string' ? metadata.imageName : undefined, repairOf: jobId,
        });
        if (accepted.resumed === true) {
          const result = await readJobResult(client, repairId, false);
          if (result.status === 202) return pending('repairing');
          return { status: 200, body: { ...result.body, warnings: [...result.body.warnings as string[], 'AI 草稿已自动修正一次格式，请核对题目条件后应用。'] } };
        }
        log('interpret_repair_started', { jobId, sessionId: session.id, repairJobId: repairId, diagnostic: draftDiagnostic(lastFailure.code, lastFailure.message) });
        return pending('repairing');
      }
    }
    log('interpret_failed', { jobId, sessionId: session.id, lastErrorCode: lastFailure.code, lastErrorReason: draftDiagnostic(lastFailure.code, lastFailure.message) });
    lastFailure.diagnostic = draftDiagnostic(lastFailure.code, lastFailure.message);
    throw lastFailure;
  }

  if (stale) {
    log('interpret_stale', { jobId, sessionId: session.id, eventTypes: Object.fromEntries(typeCounts) });
    throw new InterpretError('ai_timeout', 504);
  }
  return { status: 202, body: { ok: true, pending: true, jobId } };
}

export { MAX_IMAGE_BYTES, MAX_TEXT_CHARS };
