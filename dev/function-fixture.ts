// Credential-free local check for the app Function. Run with:
//   node --experimental-strip-types dev/function-fixture.ts
// It injects a fake Cloud Agents client, so no PAT and no cloud resources are used.
import { handler } from '../functions/handler.ts';
import { CloudAgentsError } from '../functions/cloud-agents.mjs';
import { createVerificationCloud } from './verification-cloud.ts';

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

type FakeOptions = {
  models?: unknown;
  existing?: boolean;
  stale?: boolean;
  noReply?: boolean;
  events?: unknown[];
  sessionAmbiguous?: boolean;
};

function fakeClient(reply: unknown, options: FakeOptions = {}) {
  const sessions: Array<Record<string, any>> = [];
  let counter = 0;
  const createdAt = options.stale ? new Date(Date.now() - 11 * 60 * 1000).toISOString() : new Date().toISOString();
  return {
    calls: [] as string[],
    sessions,
    sentContent: null as unknown,
    eventsPosts: 0,
    agentModel: null as unknown,
    request(path: string, opts?: { method?: string; body?: any; idempotencyKey?: string }) {
      this.calls.push(`${opts?.method ?? 'GET'} ${path}`);
      if (path === '/api/v1/cloud/models') {
        return Promise.resolve(options.models ?? { data: [{ id: 'model-a', is_enabled: true }, { id: 'model-b', is_enabled: false }] });
      }
      if (path === '/api/v1/cloud/agents') {
        this.agentModel = opts?.body?.model;
        return Promise.resolve({ id: 'agent_new', version: 1 });
      }
      if (path === '/api/v1/cloud/environments') return Promise.resolve({ id: 'env_new' });
      if (path === '/api/v1/cloud/sessions' && opts?.method === 'POST') {
        counter += 1;
        const session = { id: `sess_test_${counter}`, metadata: opts.body?.metadata ?? {}, created_at: createdAt };
        sessions.push(session);
        if (options.sessionAmbiguous) sessions.push({ ...session, id: `sess_test_${counter}_dup` });
        return Promise.resolve(session);
      }
      if (path.startsWith('/api/v1/cloud/sessions?')) {
        return Promise.resolve({ data: sessions, has_more: false });
      }
      if (path.endsWith('/events') && opts?.method === 'POST') {
        this.sentContent = opts.body.events[0].content;
        this.eventsPosts += 1;
        return Promise.resolve({ id: 'evt_user' });
      }
      if (path.includes('/events?')) {
        const data = options.events
          ?? (options.noReply ? [{ type: 'session.created' }] : [
            { type: 'user.message', content: [] },
            { type: 'agent.message', content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] },
          ]);
        return Promise.resolve({ data, has_more: false });
      }
      return Promise.reject(new Error(`unexpected call ${path}`));
    },
    findResources() {
      return Promise.resolve(options.existing ? [{ id: 'agent_existing', version: 3 }] : []);
    },
  };
}

function depsFor(client: unknown) {
  return { client: () => client };
}

function post(body: unknown, path = 'http://site/functions/v1/app/interpret') {
  return new Request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function resultGet(job: string) {
  return new Request(`http://site/functions/v1/app/interpret?job=${encodeURIComponent(job)}`);
}

async function start(client: unknown, body: unknown) {
  return handler(post(body), depsFor(client));
}

async function result(client: unknown, job: string) {
  return handler(resultGet(job), depsFor(client));
}

async function flow(client: ReturnType<typeof fakeClient>, body: unknown) {
  const accepted = await start(client, body);
  const acceptedJson = await accepted.json();
  if (accepted.status !== 202) return { accepted, acceptedJson, draftResp: null as Response | null, draftJson: null as any };
  const draftResp = await result(client, acceptedJson.jobId);
  return { accepted, acceptedJson, draftResp, draftJson: await draftResp.json() };
}

const results: string[] = [];
function check(label: string, condition: boolean, detail = '') {
  results.push(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

// --- 受理 + 轮询主流程 ---

const health = await handler(new Request('http://site/functions/v1/app?name=Physics'), depsFor(fakeClient(VALID_DRAFT)));
check('GET 健康检查保留', health.status === 200 && (await health.json()).message === 'Hello, Physics!');

const textClient = fakeClient(VALID_DRAFT);
const textFlow = await flow(textClient, { text: '倾角 30° 的斜面长 5 m，求到达底端时间。' });
check('POST 受理返回 202 与 jobId', textFlow.accepted.status === 202 && /^[a-f0-9]{64}$/.test(textFlow.acceptedJson.jobId), `status=${textFlow.accepted.status}`);
check('轮询结果返回 SceneDraft', textFlow.draftResp?.status === 200 && textFlow.draftJson?.scene?.version === 2
  && ['source', 'scene', 'known', 'assumed', 'unknown', 'uncertain', 'warnings'].every((key) => key in textFlow.draftJson),
  `status=${textFlow.draftResp?.status}`);
check('会话元数据携带 job 指纹', textClient.sessions[0]?.metadata?.job === textFlow.acceptedJson.jobId);

const resumeResp = await start(textClient, { text: '倾角 30° 的斜面长 5 m，求到达底端时间。' });
const resumeJson = await resumeResp.json();
check('同题重提复用会话且不重发消息', resumeResp.status === 202 && resumeJson.resumed === true
  && textClient.sessions.length === 1 && textClient.eventsPosts === 1,
  `sessions=${textClient.sessions.length} eventsPosts=${textClient.eventsPosts}`);

const imageClient = fakeClient(VALID_DRAFT);
const imageFlow = await flow(imageClient, { text: '看图建模', imageBase64: PNG_1PX, imageName: '题图.png' });
const blocks = imageClient.sentContent as Array<Record<string, any>>;
check('图片题带 image content block', imageFlow.draftResp?.status === 200 && blocks?.[1]?.type === 'image'
  && blocks[1].source?.media_type === 'image/png' && blocks[1].source?.type === 'base64',
  JSON.stringify(blocks?.map((block) => block.type)));
check('图片名进入会话元数据供结果回填', imageClient.sessions[0]?.metadata?.imageName === '题图.png'
  && imageFlow.draftJson?.source?.imageName === '题图.png');

const reuseClient = fakeClient(VALID_DRAFT, { existing: true });
await flow(reuseClient, { text: '斜面' });
check('已有 Agent/Environment 时复用，不再创建', !reuseClient.calls.some((call) => /POST \/api\/v1\/cloud\/(agents|environments)/.test(call)), reuseClient.calls.join(' | '));

// --- 模型选择 ---

const autoMix = fakeClient(VALID_DRAFT, { models: { data: [
  { id: 'auto', is_enabled: true }, { id: 'gmodel', is_enabled: true }, { id: 'fast', is_enabled: true },
] } });
await flow(autoMix, { text: '看图' });
check('排除 auto 路由别名并优先 fast', autoMix.agentModel === 'fast', `model=${autoMix.agentModel}`);

const noFast = fakeClient(VALID_DRAFT, { models: { data: [
  { id: 'auto', is_enabled: true }, { id: 'gmodel', is_enabled: true }, { id: 'dmodel', is_enabled: true },
] } });
const noFastFlow = await flow(noFast, { text: '看图' });
check('无 fast 时取排序首个具体模型', noFastFlow.accepted.status === 202 && noFast.agentModel === 'dmodel', `model=${noFast.agentModel}`);

const autoOnly = await start(fakeClient(VALID_DRAFT, { models: { data: [{ id: 'auto', is_enabled: true }] } }), { text: '看图' });
check('仅有 auto 时返回 503', autoOnly.status === 503 && (await autoOnly.json()).error === 'ai_model_unavailable');

const noModel = await start(fakeClient(VALID_DRAFT, { models: { data: [{ id: 'x', is_enabled: false }] } }), { text: '看图' });
check('无可用模型返回 503', noModel.status === 503 && (await noModel.json()).error === 'ai_model_unavailable');

// --- 结果查询边界 ---

const pendingClient = fakeClient(VALID_DRAFT, { noReply: true });
const pendingFlow = await flow(pendingClient, { text: '看图' });
check('无回复时轮询返回 202 pending', pendingFlow.draftResp?.status === 202 && pendingFlow.draftJson?.pending === true);

const staleFlow = await flow(fakeClient(VALID_DRAFT, { noReply: true, stale: true }), { text: '看图' });
check('超龄无回复返回 504 ai_timeout', staleFlow.draftResp?.status === 504 && staleFlow.draftJson?.error === 'ai_timeout');

const badJob = await handler(new Request('http://site/functions/v1/app/interpret/result?job=zz'), depsFor(fakeClient(VALID_DRAFT)));
check('非法 job 返回 400 invalid_job', badJob.status === 400 && (await badJob.json()).error === 'invalid_job');

const missingJob = await handler(new Request('http://site/functions/v1/app/interpret/result'), depsFor(fakeClient(VALID_DRAFT)));
check('缺少 job 返回 400', missingJob.status === 400);

const subpathClient = fakeClient(VALID_DRAFT);
const subpathJob = (await start(subpathClient, { text: '看图' })).json();
const subpathResp = await handler(new Request(`http://site/functions/v1/app/interpret/result?job=${(await subpathJob).jobId}`), depsFor(subpathClient));
check('旧 /result 子路径仍返回草稿', subpathResp.status === 200 && (await subpathResp.json()).scene?.version === 2);

const healthResp = await handler(new Request('http://site/functions/v1/app/interpret'), depsFor(fakeClient(VALID_DRAFT)));
check('无 job 的 GET 仍为健康检查', healthResp.status === 200 && (await healthResp.json()).ok === true);

const unknownJob = await result(fakeClient(VALID_DRAFT), 'a'.repeat(64));
check('未知 job 返回 404 job_not_found', unknownJob.status === 404 && (await unknownJob.json()).error === 'job_not_found');

const ambiguousSession = fakeClient(VALID_DRAFT, { sessionAmbiguous: true });
const ambStart = await start(ambiguousSession, { text: '看图' });
await start(ambiguousSession, { text: '看图' });
const ambResp = await result(ambiguousSession, (await ambStart.json()).jobId);
check('会话重复匹配返回 503 ai_resource_ambiguous', ambResp.status === 503 && (await ambResp.json()).error === 'ai_resource_ambiguous');

// --- 草稿校验 ---

const big = 'A'.repeat(4 * 1024 * 1024);
const bigResp = await start(fakeClient(VALID_DRAFT), { text: '看图', imageBase64: big, imageName: 'photo.jpg' });
check('超上限题图返回 413 image_too_large', bigResp.status === 413 && (await bigResp.json()).error === 'image_too_large');

const badDraft = JSON.parse(JSON.stringify(VALID_DRAFT));
delete badDraft.unknown;
const badFlow = await flow(fakeClient(badDraft), { text: '看图' });
check('缺字段草稿被服务端拒绝', badFlow.draftResp?.status === 502 && badFlow.draftJson?.error === 'ai_draft_invalid');

const badPath = structuredClone(VALID_DRAFT);
badPath.known[0].path = 'supports.doesNotExist.length';
const pathFlow = await flow(fakeClient(badPath), { text: '看图' });
check('草稿路径不可解析时拒绝', pathFlow.draftResp?.status === 502 && pathFlow.draftJson?.error === 'ai_draft_invalid');

const prefixed = structuredClone(VALID_DRAFT);
prefixed.scene.bindings = { 'scene.supports.s1.angleDeg': 'theta' };
prefixed.known[0].path = 'scene.supports.s1.length';
prefixed.uncertain = ['scene.contacts.c1.mu_k'];
const prefixFlow = await flow(fakeClient(prefixed), { text: '看图' });
check('scene. 前缀路径归一化后受理', prefixFlow.draftResp?.status === 200
  && Object.keys(prefixFlow.draftJson.scene.bindings)[0] === 'supports.s1.angleDeg'
  && prefixFlow.draftJson.known[0].path === 'supports.s1.length'
  && prefixFlow.draftJson.uncertain[0] === 'contacts.c1.mu_k');

const guessFlow = await flow(fakeClient('图中角度看起来约 45 度，我按 45 计算'), { text: '看图' });
check('非 JSON 回复返回 502', guessFlow.draftResp?.status === 502 && guessFlow.draftJson?.error === 'ai_draft_unparseable');

const fencedFlow = await flow(fakeClient('```json\n' + JSON.stringify(VALID_DRAFT) + '\n```'), { text: '看图' });
check('容忍 Markdown 代码块包裹', fencedFlow.draftResp?.status === 200);

// --- 事件分页与流式分片 ---

function pagedClient() {
  const base = fakeClient(VALID_DRAFT);
  const original = base.request.bind(base);
  base.request = (path: string, opts?: { method?: string; body?: any }) => {
    if (path.includes('/events?') && opts?.method !== 'POST') {
      base.calls.push(`GET ${path}`);
      if (path.includes('page=cursor2')) {
        return Promise.resolve({ data: [{ type: 'agent.message', content: [{ type: 'text', text: JSON.stringify(VALID_DRAFT) }] }], has_more: false });
      }
      return Promise.resolve({ data: [{ type: 'agent.thinking', content: [] }], has_more: true, next_page: 'cursor2' });
    }
    return original(path, opts);
  };
  return base;
}

const paged = pagedClient();
const pagedFlow = await flow(paged, { text: '看图' });
check('跟随事件分页读到最终草稿', pagedFlow.draftResp?.status === 200 && paged.calls.some((call) => call.includes('page=cursor2')));

const whole = JSON.stringify(VALID_DRAFT);
const cut = whole.indexOf('斜面下滑') + 2;
const splitFlow = await flow(fakeClient(VALID_DRAFT, { events: [
  { type: 'agent.message', content: [{ type: 'text', text: whole.slice(0, cut) }] },
  { type: 'agent.message', content: [{ type: 'text', text: whole.slice(cut) }] },
] }), { text: '看图' });
check('拼接跨消息的流式 JSON 分片', splitFlow.draftResp?.status === 200);

// --- 输入与协议错误 ---

const emptyText = await start(fakeClient(VALID_DRAFT), { text: '   ' });
check('空题面返回 400', emptyText.status === 400 && (await emptyText.json()).error === 'invalid_text');

const wrongPath = await handler(post({ text: '看图' }, 'http://site/functions/v1/app/other'), depsFor(fakeClient(VALID_DRAFT)));
check('未知 POST 路径返回 404', wrongPath.status === 404);

const putResp = await handler(new Request('http://site/functions/v1/app/interpret', { method: 'PUT' }), depsFor(fakeClient(VALID_DRAFT)));
check('PUT 返回 405 且带 Allow', putResp.status === 405 && putResp.headers.get('allow') === 'GET, POST');

const notJson = await handler(new Request('http://site/functions/v1/app/interpret', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' }), depsFor(fakeClient(VALID_DRAFT)));
check('非 JSON 请求体返回 415', notJson.status === 415);

const notImage = Buffer.from('this is plain text, not an image').toString('base64');
const badImage = await start(fakeClient(VALID_DRAFT), { text: '看图', imageBase64: notImage, imageName: 'notes.txt' });
check('非法图片返回 415 unsupported_image_type', badImage.status === 415 && (await badImage.json()).error === 'unsupported_image_type');

const mismatchedImage = await start(fakeClient(VALID_DRAFT), { text: '看图', imageBase64: PNG_1PX, imageName: 'photo.jpg' });
check('图片文件头与扩展名不一致时拒绝', mismatchedImage.status === 415 && (await mismatchedImage.json()).error === 'unsupported_image_type');

const badBase64 = await start(fakeClient(VALID_DRAFT), { text: '看图', imageBase64: 'not*base64!', imageName: 'a.png' });
check('非法 base64 返回 400 invalid_image_base64', badBase64.status === 400 && (await badBase64.json()).error === 'invalid_image_base64');

const longText = await start(fakeClient(VALID_DRAFT), { text: '题'.repeat(8001) });
check('超长题面返回 413 text_too_large', longText.status === 413 && (await longText.json()).error === 'text_too_large');

const brokenJson = await handler(new Request('http://site/functions/v1/app/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":' }), depsFor(fakeClient(VALID_DRAFT)));
check('非法 JSON 请求体返回 400 invalid_json', brokenJson.status === 400 && (await brokenJson.json()).error === 'invalid_json');

const hugeBody = await handler(new Request('http://site/functions/v1/app/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(9 * 1024 * 1024) }) }), depsFor(fakeClient(VALID_DRAFT)));
check('超 8 MiB 请求体返回 413 payload_too_large', hugeBody.status === 413 && (await hugeBody.json()).error === 'payload_too_large');

// --- 云端错误映射 ---

function failingClient(error: unknown) {
  return { request: () => Promise.reject(error), findResources: () => Promise.resolve([]) };
}

const limited = await start(failingClient(new CloudAgentsError('ai_rate_limited', 429, 'rejected')), { text: '看图' });
check('429 额度耗尽映射为 rate_limited', limited.status === 429 && (await limited.json()).error === 'rate_limited');

const unavailable = await start(failingClient(new CloudAgentsError('ai_service_unavailable', 503, 'unknown')), { text: '看图' });
check('云端不可用映射为 service_unavailable', unavailable.status === 503 && (await unavailable.json()).error === 'service_unavailable');

const noPat = await start(failingClient(new CloudAgentsError('ai_not_configured', 503, 'not_sent')), { text: '看图' });
check('缺少服务端凭据映射为 service_not_configured', noPat.status === 503 && (await noPat.json()).error === 'service_not_configured');

const ambiguous = fakeClient(VALID_DRAFT);
ambiguous.findResources = () => Promise.resolve([{ id: 'agent_a', version: 1 }, { id: 'agent_b', version: 1 }]);
const ambiguousResp = await start(ambiguous, { text: '看图' });
check('资源重复时返回 503 ai_resource_ambiguous', ambiguousResp.status === 503 && (await ambiguousResp.json()).error === 'ai_resource_ambiguous');

// --- 完整电磁与阶段草稿经真实 handler 返回，不剥离新版字段 ---
const fieldDraft:any=structuredClone(VALID_DRAFT);
fieldDraft.scene.supports=[];fieldDraft.scene.contacts=[];fieldDraft.scene.params=[];fieldDraft.scene.bindings={};
fieldDraft.scene.bodies=[{id:'A',kind:'ball',name:'A',attach:null,pos:{x:0,y:.8},vel:{x:2,y:0},mass:.1,accel:null,charged:true,charge:.0001}];
fieldDraft.scene.fields=[{id:'E',name:'电场',kind:'uniform_electric',enabled:true,shape:{kind:'global'},position:{x:0,y:0},vector:{x:0,y:10000},bz:0,sourceStrength:0,cutoffRadius:.001},
  {id:'B',name:'磁场',kind:'uniform_magnetic',enabled:true,shape:{kind:'global'},position:{x:0,y:0},vector:{x:0,y:0},bz:-.5,sourceStrength:0,cutoffRadius:.001}];
fieldDraft.scene.asks=[{id:'motion',kind:'motion_analysis',t:null,x:null,y:null,v:null},{id:'ret',kind:'return_to_initial_x',t:null,x:null,y:0,v:null}];
fieldDraft.known=[{path:'bodies.A.charge',label:'电荷',value:'0.0001 C'},{path:'fields.E.vector.y',label:'电场',value:'10000 N/C'}];
fieldDraft.assumed=[];fieldDraft.unknown=[{path:'asks.motion',label:'性质、半径与周期'}];fieldDraft.uncertain=[];
fieldDraft.stages=[{id:'field',title:'复合场',scene:structuredClone(fieldDraft.scene)}];
const fieldFlow=await flow(fakeClient(fieldDraft),{text:'带电小球在电场和磁场中的运动'});
check('场和电荷经受理轮询返回不丢失',fieldFlow.draftResp?.status===200&&fieldFlow.draftJson.scene.bodies[0].charge===.0001&&fieldFlow.draftJson.scene.fields[1].bz===-.5);
check('新版待求与分阶段场景经服务端完整保留',fieldFlow.draftJson?.scene?.asks[1]?.kind==='return_to_initial_x'&&fieldFlow.draftJson?.stages?.[0]?.scene?.fields?.length===2);

// --- 真实 handler 的格式修正、未完成流与显式重新生成 ---
const brokenFieldDraft = structuredClone(fieldDraft);
brokenFieldDraft.scene.bodies[0].kind = 'sphere';
const recoveryClient = createVerificationCloud(brokenFieldDraft, { repairReply: fieldDraft });
const recoveryStart = await start(recoveryClient, { text: '带电小球在电场和磁场中的运动' });
const recoveryJob = (await recoveryStart.json()).jobId;
const recovering = await result(recoveryClient, recoveryJob);
check('无效草稿进入一次格式修正而非立即失败', recovering.status === 202 && (await recovering.json()).phase === 'repairing');
const recovered = await result(recoveryClient, recoveryJob);
check('修正后草稿通过原有严格校验', recovered.status === 200 && (await recovered.json()).scene.bodies[0].kind === 'ball');
await result(recoveryClient, recoveryJob);
check('重复轮询不会新增格式修正任务', recoveryClient.sessions.length === 2 && recoveryClient.prompts.length === 2);
const streamClient = createVerificationCloud('{"scene":');
const streamJob = (await (await start(streamClient, { text: '小球运动' })).json()).jobId;
check('未完成的 JSON 流继续等待', (await result(streamClient, streamJob)).status === 202 && streamClient.sessions.length === 1);
const freshJob = (await (await start(recoveryClient, { text: '带电小球在电场和磁场中的运动', generationId: 'fresh-generation' })).json()).jobId;
check('显式重新生成不会命中失败旧会话', freshJob !== recoveryJob && recoveryClient.sessions.length === 3);

// --- 日志安全：只允许计数、资源 ID、错误码与诊断字段 ---

const MARKER = 'ZZ-LOG-MARKER-题面原文';
const captured: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => { captured.push(args.map((arg) => String(arg)).join(' ')); };
try {
  await flow(fakeClient(VALID_DRAFT), { text: `${MARKER} 斜面长 5 m`, imageBase64: PNG_1PX, imageName: '题图.png' });
  await flow(fakeClient(VALID_DRAFT, { noReply: true }), { text: MARKER });
  await flow(fakeClient('模型拒绝输出 JSON'), { text: MARKER });
} finally {
  console.log = originalLog;
}
const logText = captured.join('\n');
check('日志不含题面原文', captured.length > 0 && !logText.includes(MARKER));
check('日志不含题图 base64', !logText.includes(PNG_1PX.slice(0, 24)));
check('日志不含凭据字段', !/QODER_PAT|Bearer |authorization/i.test(logText));
check('日志不含模型原始输出', !logText.includes('斜面下滑') && !logText.includes('"scene"'));
check('日志保留安全诊断字段', logText.includes('interpret_start') && logText.includes('interpret_done')
  && logText.includes('sessionId') && logText.includes('jobId') && logText.includes('lastErrorCode'));

console.log(results.join('\n'));
const failed = results.some((line) => line.startsWith('FAIL'));
console.log(failed ? '\nFIXTURE: FAILED' : '\nFIXTURE: ALL PASSED');
if (failed) process.exitCode = 1;
