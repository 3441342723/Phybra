import { validateSceneDraft, DraftContractError } from './draft-schema.ts';

// Trusted server-only configuration. The origin is copied from the Sites runtime
// context (get_context.runtime.cloudAgents.apiOrigin); QODER_PAT is read only by the
// QCA client inside the Function runtime and never appears here.
export const CLOUD_API_ORIGIN = 'https://api.qoder.com.cn';
export const CLOUD_REQUEST_TIMEOUT_MS = 12000;

const APP_SCOPE = 'physics-workbench-p3-1';
const PURPOSE = 'scene-interpret';
const MAX_TEXT_CHARS = 8000;
const MAX_IMAGE_BYTES = 600 * 1024;
// The Sites gateway drops a request at about 100 s and answers 504 on its own, so
// the budget must finish earlier for the caller to receive our error code instead.
const TOTAL_BUDGET_MS = 85000;
const POLL_INTERVAL_MS = 1500;
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const SYSTEM_PROMPT = `你是高中物理场景建模器。只输出一个 JSON 对象，不要输出 Markdown 代码块、解释或任何额外文字。

JSON 必须严格满足以下结构（字段一个都不能少）：
{
  "source": {},
  "scene": {
    "version": 2,
    "rev": 0,
    "title": "题目简述",
    "gravity": number|null,
    "bodies": [{ "id": string, "kind": "block"|"projectile", "name": string,
                 "attach": {"support": string, "s": number|null}|null,
                 "pos": {"x": number|null, "y": number|null},
                 "vel": {"x": number|null, "y": number|null},
                 "mass": number|null, "accel": number|null }],
    "supports": [{ "id": string, "name": string, "kind": "horizontal"|"incline",
                   "a": {"x": number, "y": number}, "length": number|null, "angleDeg": number|null }],
    "contacts": [{ "id": string, "body": string, "support": string,
                   "mu_s": number|null, "mu_k": number|null }],
    "asks": [{ "id": string, "kind": "at_time"|"at_height"|"at_position"|"at_velocity"|"landing"|"apex"|"rest"|"end_of_support"|"friction_state",
               "t": number|null, "x": number|null, "y": number|null, "v": number|null }],
    "params": [{ "name": string, "value": number|null,
                 "unit": "length"|"time"|"speed"|"accel"|"mass"|"angle"|"none",
                 "min": number, "max": number, "step": number }],
    "bindings": { "对象属性路径": "params 中已存在的 name" }
  },
  "known": [{ "path": string, "label": string, "value": string, "quote"?: string, "basis"?: string }],
  "assumed": [{ "path": string, "label": string, "value": string, "quote"?: string, "basis"?: string }],
  "unknown": [{ "path": string, "label": string }],
  "uncertain": [string],
  "warnings": [string]
}

建模规则：
1. 题目没有明给的物理量一律填 null。绝不猜测，绝不默认成 0，也绝不按图片中线段或角度的比例反推数值。
2. 图片只用来识别题目文字、符号与几何关系。从图片读出的数值必须能在题面文字或标注中找到依据；找不到依据就填 null 并列入 unknown，同时把该 path 写进 uncertain。
3. 每个集合内的 id 必须唯一；bodies.attach.support、contacts.body/support 必须引用已存在的 id。
4. known/assumed/unknown 的 path 与 uncertain 的每一项都必须能解析到 scene 里的字段，形如 "supports.s1.angleDeg"、"bodies.b1.mass"、"asks.a1.t"；bindings 的键同理，bindings 的值必须是 params 中已存在的 name。
5. known 记录题目明说的量，并把题面原文片段写进 quote；assumed 记录你补充的常规条件（例如 g 取 9.8、不计空气阻力），理由写进 basis；unknown 记录题目要求或需要但缺失的量。
6. asks 只写题目要求解的目标；求解所需的中间未知量放 unknown。
7. params 用于可调节量，min<=max 且 step>0；无明确范围时用合理的物理范围。
8. 单位统一用国际单位制，角度用度。
9. 无法归入上述结构的，写进 warnings，不要私自扩展字段。
10. supports.length 必须是有限正数。它是建模用的轨道范围，不是题给物理量：题目未给边界时取足以覆盖整个运动过程的范围（例如水平面取 100 m），并把这一约定写进 assumed。不要创建与运动无关的支撑面；平抛/斜抛在空中运动时不需要地面 support 与 contact。
11. asks 的 kind 必须匹配题目所求，且 at_time/at_height/at_position/at_velocity 必须给出对应目标数值（t/y/x/v）。题目没有给目标值时，改用 rest、landing、apex、end_of_support、friction_state 这类无需目标值的 kind：求"滑行距离/停下时间"用 rest，求"到达底端"用 end_of_support。
12. kind 为 horizontal 的支撑面 angleDeg 必须填 0（这是水平面的定义值，不属于猜测）；kind 为 incline 时 angleDeg 只能来自题面，未给就填 null。
13. 用于求解的 contact 需要 mu_s：题目明给就用题给值；题目说"光滑"填 0；题目只给 mu_k 时取 mu_s = mu_k，并把这一常规近似写进 assumed（注明题目未给静摩擦因数）。与求解无关的接触才允许 mu_s 为 null。
14. kind 为 block 的物体 attach 不能为 null：support 填该物体 contact 指向的支撑面 id，s 填沿面位置（起点/顶端按题意换算，未知时 s 可为 null）。只有 projectile 才允许 attach 为 null。输出前自检 10～14 条。`;

export class InterpretError extends Error {
  status: number;
  code: string;
  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
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
};

export function parseInterpretInput(body: unknown): InterpretInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new InterpretError('invalid_payload', 400);
  const input = body as Record<string, unknown>;
  if (typeof input.text !== 'string') throw new InterpretError('invalid_text', 400);
  const text = input.text.trim();
  if (!text) throw new InterpretError('invalid_text', 400, 'text is empty');
  if (text.length > MAX_TEXT_CHARS) throw new InterpretError('text_too_large', 413);
  if (input.imageName !== undefined && typeof input.imageName !== 'string') throw new InterpretError('invalid_image_name', 400);
  const imageName = typeof input.imageName === 'string' ? input.imageName.slice(0, 200) : '';
  if (input.imageBase64 === undefined || input.imageBase64 === null || input.imageBase64 === '') return { text, image: null };
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
  return { text, image: { base64: input.imageBase64, mediaType, name: imageName } };
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

function extractDraft(text: string, source: Record<string, unknown>): Record<string, unknown> {
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
    throw new InterpretError('ai_draft_invalid', 502, reason);
  }
}

const MAX_EVENT_PAGES = 20;

// A long session produces more than one page of events; reading only the first
// page would never reach the final answer.
async function readEventTexts(
  client: CloudClient,
  sessionId: string,
  deadline: number,
  typeCounts: Map<string, number>,
): Promise<{ texts: string[]; hasMore: boolean }> {
  const texts: string[] = [];
  let page: string | undefined;
  let hasMore = false;
  for (let index = 0; index < MAX_EVENT_PAGES && Date.now() < deadline; index += 1) {
    const query = `/api/v1/cloud/sessions/${sessionId}/events?order=asc&limit=100${page ? `&page=${encodeURIComponent(page)}` : ''}`;
    const result = await client.request(query);
    for (const event of (Array.isArray(result?.data) ? result.data : [])) {
      const type = typeof event?.type === 'string' ? event.type : 'unknown';
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
      if (type !== 'agent.message') continue;
      const text = collectText(event.content);
      if (text.length > 0) texts.push(text);
    }
    hasMore = result?.has_more === true;
    if (!hasMore || typeof result?.next_page !== 'string' || !result.next_page) break;
    page = result.next_page;
  }
  return { texts, hasMore };
}

export async function interpretRequest(
  client: CloudClient,
  body: unknown,
  sleep: (ms: number) => Promise<void>,
): Promise<Record<string, unknown>> {
  const { text, image } = parseInterpretInput(body);
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  const models = await client.request('/api/v1/cloud/models');
  const enabled: string[] = (Array.isArray(models?.data) ? models.data : [])
    .filter((model: Record<string, unknown>) => model?.is_enabled === true && typeof model?.id === 'string')
    .map((model: Record<string, unknown>) => model.id as string)
    .sort();
  if (!enabled.length) throw new InterpretError('ai_model_unavailable', 503);
  // Stable selection: the model list is sorted, so the same account configuration
  // always resolves to the same id. Re-pin here after reading the runtime log.
  const model = enabled[0];
  log('interpret_start', { model, enabledModels: enabled.slice(0, 20), hasImage: Boolean(image), textChars: text.length });

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
      title: `读题 ${text.slice(0, 40)}`,
      metadata: { app: APP_SCOPE, purpose: PURPOSE },
    },
  });
  if (typeof session?.id !== 'string') throw new InterpretError('ai_response_invalid', 502);

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: image ? `${text}\n\n（随题附题图一张，题面数值以文字与图中标注为准。）` : text },
  ];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });

  await client.request(`/api/v1/cloud/sessions/${session.id}/events`, {
    method: 'POST',
    body: { events: [{ type: 'user.message', content }] },
  });

  const source: Record<string, unknown> = { rawText: text };
  if (image?.name) source.imageName = image.name;

  let lastFailure: InterpretError | null = null;
  let sawAgentReply = false;
  let polls = 0;
  // Keep the number of polls bounded even when a test or platform adapter
  // supplies a no-op sleep implementation. In the live runtime the 2 s sleep
  // still enforces the 110 s wall-clock budget; this guard prevents a tight
  // loop from exhausting CPU when the clock does not advance between polls.
  const maxPolls = Math.ceil(TOTAL_BUDGET_MS / POLL_INTERVAL_MS);
  const typeCounts = new Map<string, number>();
  let lastHasMore = false;
  while (Date.now() < deadline && polls < maxPolls) {
    const { texts, hasMore } = await readEventTexts(client, session.id, deadline, typeCounts);
    polls += 1;
    lastHasMore = hasMore;
    if (texts.length > 0) sawAgentReply = true;
    for (let index = texts.length - 1; index >= 0; index -= 1) {
      try {
        const draft = extractDraft(texts[index], source);
        log('interpret_done', { sessionId: session.id, model, polls, elapsedMs: Date.now() - (deadline - TOTAL_BUDGET_MS) });
        return draft;
      } catch (error) {
        if (error instanceof InterpretError) lastFailure = error;
      }
    }
    // A streamed answer can be split across several agent.message events.
    if (texts.length > 1) {
      try {
        const draft = extractDraft(texts.join(''), source);
        log('interpret_done', { sessionId: session.id, model, polls, elapsedMs: Date.now() - (deadline - TOTAL_BUDGET_MS) });
        return draft;
      } catch (error) {
        if (error instanceof InterpretError) lastFailure = error;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  log('interpret_incomplete', {
    sessionId: session.id, model, polls, elapsedMs: Date.now() - (deadline - TOTAL_BUDGET_MS),
    sawAgentReply, lastHasMore, eventTypes: Object.fromEntries(typeCounts),
    ...(lastFailure ? { lastErrorCode: lastFailure.code, lastErrorReason: lastFailure.message.slice(0, 160) } : {}),
  });
  if (sawAgentReply && lastFailure) throw lastFailure;
  throw new InterpretError(sawAgentReply ? 'ai_draft_invalid' : 'ai_timeout', 504);
}

export { MAX_IMAGE_BYTES, MAX_TEXT_CHARS, TOTAL_BUDGET_MS };
