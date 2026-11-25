// Credential-free local check for the app Function. Run with:
//   node --experimental-strip-types dev/function-fixture.ts
// It injects a fake Cloud Agents client, so no PAT and no cloud resources are used.
import { handler } from '../functions/handler.ts';
import { CloudAgentsError } from '../functions/cloud-agents.mjs';

const VALID_DRAFT = {
  source: {},
  scene: {
    version: 2, rev: 0, title: '斜面下滑', gravity: 9.8,
    bodies: [{ id: 'b1', kind: 'block', name: '滑块', attach: { support: 's1', s: null }, pos: { x: null, y: null }, vel: { x: 0, y: 0 }, mass: null, accel: null }],
    supports: [{ id: 's1', name: '斜面', kind: 'incline', a: { x: 0, y: 0 }, length: 5, angleDeg: 30 }],
    contacts: [{ id: 'c1', body: 'b1', support: 's1', mu_s: 0.4, mu_k: null }],
    asks: [{ id: 'a1', kind: 'end_of_support', t: null, x: null, y: null, v: null }],
    params: [{ name: 'theta', value: 30, unit: 'angle', min: 0, max: 60, step: 1 }],
    bindings: { 'supports.s1.angleDeg': 'theta' },
  },
  known: [{ path: 'supports.s1.length', label: '斜面长', value: '5 m', quote: '长 5 m' }],
  assumed: [{ path: 'gravity', label: '重力加速度', value: '9.8', basis: '题目未给，取常规值' }],
  unknown: [{ path: 'contacts.c1.mu_k', label: '动摩擦因数' }],
  uncertain: [],
  warnings: ['缺少 μ_k，无法求解'],
};

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let sentContent: unknown = null;

function fakeClient(reply: unknown, options: { models?: unknown; existing?: boolean } = {}) {
  const resources = options.existing
    ? [{ id: 'agent_existing', version: 3 }, { id: 'env_existing' }]
    : [];
  return {
    calls: [] as string[],
    request(path: string, opts?: { method?: string; body?: any }) {
      this.calls.push(`${opts?.method ?? 'GET'} ${path}`);
      if (path === '/api/v1/cloud/models') {
        return Promise.resolve(options.models ?? { data: [{ id: 'model-a', is_enabled: true }, { id: 'model-b', is_enabled: false }] });
      }
      if (path === '/api/v1/cloud/agents') return Promise.resolve({ id: 'agent_new', version: 1 });
      if (path === '/api/v1/cloud/environments') return Promise.resolve({ id: 'env_new' });
      if (path === '/api/v1/cloud/sessions') return Promise.resolve({ id: 'sess_test' });
      if (path.endsWith('/events') && opts?.method === 'POST') {
        sentContent = opts.body.events[0].content;
        return Promise.resolve({ id: 'evt_user' });
      }
      if (path.includes('/events?')) {
        const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
        return Promise.resolve({ data: [{ type: 'agent.message', content: [{ type: 'text', text }] }] });
      }
      return Promise.reject(new Error(`unexpected call ${path}`));
    },
    findResources() {
      return Promise.resolve(options.existing ? [{ id: 'agent_existing', version: 3 }] : []);
    },
  };
}

function depsFor(client: unknown) {
  return { client: () => client, sleep: async () => {} };
}

function post(body: unknown, path = 'http://site/functions/v1/app/interpret') {
  return new Request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const results: string[] = [];
function check(label: string, condition: boolean, detail = '') {
  results.push(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const health = await handler(new Request('http://site/functions/v1/app?name=Physics'), depsFor(fakeClient(VALID_DRAFT)));
check('GET 健康检查保留', health.status === 200 && (await health.json()).message === 'Hello, Physics!');

sentContent = null;
const textResp = await handler(post({ text: '倾角 30° 的斜面长 5 m，求到达底端时间。' }), depsFor(fakeClient(VALID_DRAFT)));
const textJson = await textResp.json();
check('文字题返回 SceneDraft', textResp.status === 200 && textJson.scene?.version === 2
  && ['source', 'scene', 'known', 'assumed', 'unknown', 'uncertain', 'warnings'].every((key) => key in textJson),
  `status=${textResp.status}`);
check('source 由服务端请求回填', textJson.source?.rawText?.includes('倾角 30°'), JSON.stringify(textJson.source));

const reuse = fakeClient(VALID_DRAFT, { existing: true });
await handler(post({ text: '斜面' }), depsFor(reuse));
check('已有 Agent/Environment 时复用，不再创建', !reuse.calls.some((call) => /POST \/api\/v1\/cloud\/(agents|environments)/.test(call)), reuse.calls.join(' | '));

sentContent = null;
const imageResp = await handler(post({ text: '看图建模', imageBase64: PNG_1PX, imageName: '题图.png' }), depsFor(fakeClient(VALID_DRAFT)));
const blocks = sentContent as Array<Record<string, any>>;
check('图片题带 image content block', imageResp.status === 200 && blocks?.[1]?.type === 'image'
  && blocks[1].source?.media_type === 'image/png' && blocks[1].source?.type === 'base64',
  JSON.stringify(blocks?.map((block) => block.type)));

const big = 'A'.repeat(4 * 1024 * 1024);
const bigResp = await handler(post({ text: '看图', imageBase64: big, imageName: 'photo.jpg' }), depsFor(fakeClient(VALID_DRAFT)));
check('超上限题图返回 413 image_too_large', bigResp.status === 413 && (await bigResp.json()).error === 'image_too_large');

const badDraft = JSON.parse(JSON.stringify(VALID_DRAFT));
delete badDraft.unknown;
const badResp = await handler(post({ text: '看图' }), depsFor(fakeClient(badDraft)));
check('缺字段草稿被服务端拒绝', badResp.status === 502 && (await badResp.json()).error === 'ai_draft_invalid');

const badPath = structuredClone(VALID_DRAFT);
badPath.known[0].path = 'supports.doesNotExist.length';
const pathResp = await handler(post({ text: '看图' }), depsFor(fakeClient(badPath)));
check('草稿路径不可解析时拒绝', pathResp.status === 502 && (await pathResp.json()).error === 'ai_draft_invalid');

const guessResp = await handler(post({ text: '看图' }), depsFor(fakeClient('图中角度看起来约 45 度，我按 45 计算')));
check('非 JSON 回复返回 502', guessResp.status === 502 && (await guessResp.json()).error === 'ai_draft_unparseable');

const fenced = await handler(post({ text: '看图' }), depsFor(fakeClient('```json\n' + JSON.stringify(VALID_DRAFT) + '\n```')));
check('容忍 Markdown 代码块包裹', fenced.status === 200);

const noModel = await handler(post({ text: '看图' }), depsFor(fakeClient(VALID_DRAFT, { models: { data: [{ id: 'x', is_enabled: false }] } })));
check('无可用模型返回 503', noModel.status === 503 && (await noModel.json()).error === 'ai_model_unavailable');

const emptyText = await handler(post({ text: '   ' }), depsFor(fakeClient(VALID_DRAFT)));
check('空题面返回 400', emptyText.status === 400 && (await emptyText.json()).error === 'invalid_text');

const wrongPath = await handler(post({ text: '看图' }, 'http://site/functions/v1/app/other'), depsFor(fakeClient(VALID_DRAFT)));
check('未知 POST 路径返回 404', wrongPath.status === 404);

const putResp = await handler(new Request('http://site/functions/v1/app/interpret', { method: 'PUT' }), depsFor(fakeClient(VALID_DRAFT)));
check('PUT 返回 405 且带 Allow', putResp.status === 405 && putResp.headers.get('allow') === 'GET, POST');

const notJson = await handler(new Request('http://site/functions/v1/app/interpret', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' }), depsFor(fakeClient(VALID_DRAFT)));
check('非 JSON 请求体返回 415', notJson.status === 415);

// --- 错误流程：非法图片、非法 base64、超限题面、非法 JSON、超时、额度与凭据 ---

const notImage = Buffer.from('this is plain text, not an image').toString('base64');
const badImage = await handler(post({ text: '看图', imageBase64: notImage, imageName: 'notes.txt' }), depsFor(fakeClient(VALID_DRAFT)));
check('非法图片返回 415 unsupported_image_type', badImage.status === 415 && (await badImage.json()).error === 'unsupported_image_type');

const mismatchedImage = await handler(post({ text: '看图', imageBase64: PNG_1PX, imageName: 'photo.jpg' }), depsFor(fakeClient(VALID_DRAFT)));
check('图片文件头与扩展名不一致时拒绝', mismatchedImage.status === 415 && (await mismatchedImage.json()).error === 'unsupported_image_type');

const badBase64 = await handler(post({ text: '看图', imageBase64: 'not*base64!', imageName: 'a.png' }), depsFor(fakeClient(VALID_DRAFT)));
check('非法 base64 返回 400 invalid_image_base64', badBase64.status === 400 && (await badBase64.json()).error === 'invalid_image_base64');

const longText = await handler(post({ text: '题'.repeat(8001) }), depsFor(fakeClient(VALID_DRAFT)));
check('超长题面返回 413 text_too_large', longText.status === 413 && (await longText.json()).error === 'text_too_large');

const brokenJson = await handler(new Request('http://site/functions/v1/app/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":' }), depsFor(fakeClient(VALID_DRAFT)));
check('非法 JSON 请求体返回 400 invalid_json', brokenJson.status === 400 && (await brokenJson.json()).error === 'invalid_json');

const hugeBody = await handler(new Request('http://site/functions/v1/app/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(9 * 1024 * 1024) }) }), depsFor(fakeClient(VALID_DRAFT)));
check('超 8 MiB 请求体返回 413 payload_too_large', hugeBody.status === 413 && (await hugeBody.json()).error === 'payload_too_large');

function clientWithEvents(events: unknown[]) {
  const base = fakeClient(VALID_DRAFT);
  return {
    calls: base.calls,
    findResources: base.findResources.bind(base),
    request(path: string, opts?: { method?: string; body?: any }) {
      if (path.includes('/events?')) return Promise.resolve({ data: events, has_more: false });
      return base.request(path, opts);
    },
  };
}

const timeoutResp = await handler(post({ text: '看图' }), depsFor(clientWithEvents([{ type: 'session.created' }])));
check('无模型回复时超时返回 504 ai_timeout', timeoutResp.status === 504 && (await timeoutResp.json()).error === 'ai_timeout');

function failingClient(error: unknown) {
  return { request: () => Promise.reject(error), findResources: () => Promise.resolve([]) };
}

const limited = await handler(post({ text: '看图' }), depsFor(failingClient(new CloudAgentsError('ai_rate_limited', 429, 'rejected'))));
check('429 额度耗尽映射为 rate_limited', limited.status === 429 && (await limited.json()).error === 'rate_limited');

const unavailable = await handler(post({ text: '看图' }), depsFor(failingClient(new CloudAgentsError('ai_service_unavailable', 503, 'unknown'))));
check('云端不可用映射为 service_unavailable', unavailable.status === 503 && (await unavailable.json()).error === 'service_unavailable');

const noPat = await handler(post({ text: '看图' }), depsFor(failingClient(new CloudAgentsError('ai_not_configured', 503, 'not_sent'))));
check('缺少服务端凭据映射为 service_not_configured', noPat.status === 503 && (await noPat.json()).error === 'service_not_configured');

const ambiguous = fakeClient(VALID_DRAFT);
ambiguous.findResources = () => Promise.resolve([{ id: 'agent_a', version: 1 }, { id: 'agent_b', version: 1 }]);
const ambiguousResp = await handler(post({ text: '看图' }), depsFor(ambiguous));
check('资源重复时返回 503 ai_resource_ambiguous', ambiguousResp.status === 503 && (await ambiguousResp.json()).error === 'ai_resource_ambiguous');

// --- 事件分页与流式分片 ---

function pagedClient() {
  const base = fakeClient(VALID_DRAFT);
  return {
    calls: base.calls,
    findResources: base.findResources.bind(base),
    request(path: string, opts?: { method?: string; body?: any }) {
      if (path.includes('/events?')) {
        base.calls.push(`GET ${path}`);
        if (path.includes('page=cursor2')) {
          return Promise.resolve({ data: [{ type: 'agent.message', content: [{ type: 'text', text: JSON.stringify(VALID_DRAFT) }] }], has_more: false });
        }
        return Promise.resolve({ data: [{ type: 'agent.thinking', content: [] }], has_more: true, next_page: 'cursor2' });
      }
      return base.request(path, opts);
    },
  };
}

const paged = pagedClient();
const pagedResp = await handler(post({ text: '看图' }), depsFor(paged));
check('跟随事件分页读到最终草稿', pagedResp.status === 200 && paged.calls.some((call) => call.includes('page=cursor2')));

const whole = JSON.stringify(VALID_DRAFT);
const cut = whole.indexOf('斜面下滑') + 2;
const splitClient = clientWithEvents([
  { type: 'agent.message', content: [{ type: 'text', text: whole.slice(0, cut) }] },
  { type: 'agent.message', content: [{ type: 'text', text: whole.slice(cut) }] },
]);
const splitResp = await handler(post({ text: '看图' }), depsFor(splitClient));
check('拼接跨消息的流式 JSON 分片', splitResp.status === 200);

// --- 日志安全：只允许计数、资源 ID、错误码与诊断字段 ---

const MARKER = 'ZZ-LOG-MARKER-题面原文';
const captured: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => { captured.push(args.map((arg) => String(arg)).join(' ')); };
try {
  await handler(post({ text: `${MARKER} 斜面长 5 m`, imageBase64: PNG_1PX, imageName: '题图.png' }), depsFor(fakeClient(VALID_DRAFT)));
  await handler(post({ text: MARKER }), depsFor(clientWithEvents([{ type: 'session.created' }])));
  await handler(post({ text: MARKER }), depsFor(fakeClient('模型拒绝输出 JSON')));
} finally {
  console.log = originalLog;
}
const logText = captured.join('\n');
check('日志不含题面原文', captured.length > 0 && !logText.includes(MARKER));
check('日志不含题图 base64', !logText.includes(PNG_1PX.slice(0, 24)));
check('日志不含凭据字段', !/QODER_PAT|Bearer |authorization/i.test(logText));
check('日志不含模型原始输出', !logText.includes('斜面下滑') && !logText.includes('"scene"'));
check('日志保留安全诊断字段', logText.includes('interpret_start') && logText.includes('interpret_incomplete')
  && logText.includes('sessionId') && logText.includes('polls') && logText.includes('lastErrorCode'));

console.log(results.join('\n'));
const failed = results.some((line) => line.startsWith('FAIL'));
console.log(failed ? '\nFIXTURE: FAILED' : '\nFIXTURE: ALL PASSED');
if (failed) process.exitCode = 1;
