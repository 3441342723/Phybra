import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../functions/handler';
import { createQwenProvider, QWEN_BASE_URL, QWEN_MODEL, type QwenProviderOptions, type QwenStore } from '../functions/qwen';
import { createVerificationCloud } from '../dev/verification-cloud';
import { collisionFieldDraft, CORRECTED_COLLISION_FIELD_PROBLEM } from '../src/ai/collision-field-example';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const completion = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const sse = (content: string) => {
  const mid = Math.floor(content.length / 2);
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, mid) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: content.slice(mid) } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const badDraft = () => { const draft: any = collisionFieldDraft(); draft.scene.bodies[0].kind = 'sphere'; return draft; };
function fakeStore(): QwenStore & { paths: string[] } {
  const map = new Map<string, string>();
  return {
    paths: [] as string[],
    put: async (path, bytes) => { map.set(path, new TextDecoder().decode(bytes)); },
    get: async (path) => (map.has(path) ? JSON.parse(map.get(path)!) : null),
  };
}
function provider(fetchImpl: typeof fetch, extra: Partial<QwenProviderOptions> = {}) {
  return createQwenProvider({ fetchImpl, getKey: () => 'test-key', store: fakeStore(), ...extra });
}
function recording(fetchImpl: typeof fetch) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return fetchImpl(url, init); };
  return { calls, impl };
}
const post = (body: unknown) => new Request('http://verification.local/functions/v1/app/interpret', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('Qwen 兼容接口持久异步读题通道', () => {
  it('POST 受理 202，GET 执行一次上游并持久化草稿，重复轮询不再调用上游', async () => {
    const { calls, impl } = recording(async () => completion(JSON.stringify(collisionFieldDraft())));
    const qwen = provider(impl);
    const accepted = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    expect(accepted.resumed).toBe(false);
    expect(calls).toHaveLength(0);
    const { status, body } = await qwen.result(accepted.jobId);
    expect(status).toBe(200);
    expect((body as any).scene.bodies[0].kind).toBe('ball');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${QWEN_BASE_URL}/chat/completions`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.model).toBe(QWEN_MODEL);
    expect(sent.enable_thinking).toBe(false);
    expect(sent.stream).toBe(true);
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[1].content[0].text).toContain(CORRECTED_COLLISION_FIELD_PROBLEM);
    expect((await qwen.result(accepted.jobId)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('同题重复受理续取意图，不新建任务', async () => {
    const { calls, impl } = recording(async () => completion(JSON.stringify(collisionFieldDraft())));
    const qwen = provider(impl);
    const a = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    const b = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    expect(b.jobId).toBe(a.jobId);
    expect(b.resumed).toBe(true);
    await qwen.result(a.jobId);
    expect(calls).toHaveLength(1);
  });

  it('题图以 data URL 视觉块发送，媒体类型取自字节而非文件名', async () => {
    const { calls, impl } = recording(async () => completion(JSON.stringify(collisionFieldDraft())));
    const qwen = provider(impl);
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM, imageBase64: PNG_BASE64, imageName: 'photo.png' });
    await qwen.result(jobId);
    const sent = JSON.parse(String(calls[0].init.body));
    const image = sent.messages[1].content.find((block: any) => block.type === 'image_url');
    expect(image.image_url.url).toBe(`data:image/png;base64,${PNG_BASE64}`);
  });

  it('上游 SSE 增量拼接为完整草稿', async () => {
    const qwen = provider(async () => sse(JSON.stringify(collisionFieldDraft())));
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    const { status, body } = await qwen.result(jobId);
    expect(status).toBe(200);
    expect((body as any).scene.bodies[0].kind).toBe('ball');
  });

  it('格式错误跨请求修正一次：第二次 GET 带原题与校验反馈，成功草稿附审阅提示', async () => {
    let round = 0;
    const { calls, impl } = recording(async () => { round += 1; return completion(JSON.stringify(round === 1 ? badDraft() : collisionFieldDraft())); });
    const qwen = provider(impl);
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    const first = await qwen.result(jobId);
    expect(first.status).toBe(202);
    expect(first.body.phase).toBe('repairing');
    const { status, body } = await qwen.result(jobId);
    expect(status).toBe(200);
    expect((body as any).warnings.at(-1)).toContain('自动修正一次');
    expect(calls).toHaveLength(2);
    const repair = JSON.parse(String(calls[1].init.body));
    const repairText = repair.messages[1].content.map((block: any) => block.text ?? '').join('');
    expect(repairText).toContain(CORRECTED_COLLISION_FIELD_PROBLEM);
    expect(repairText).toContain('bodies.0.kind');
    expect(repairText).toContain('不要为了通过校验删除条件');
  });

  it('修正仍失败持久化固定原因类别，反复轮询不再创建任务', async () => {
    const { calls, impl } = recording(async () => completion(JSON.stringify(badDraft())));
    const qwen = provider(impl);
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    await qwen.result(jobId);
    for (let n = 0; n < 3; n++) {
      await expect(qwen.result(jobId)).rejects.toMatchObject({ code: 'ai_draft_invalid', diagnostic: 'object_type' });
    }
    expect(calls).toHaveLength(2);
  });

  it.each([
    [401, 'ai_provider_denied'], [403, 'ai_provider_denied'], [404, 'ai_model_unavailable'],
    [429, 'rate_limited'], [500, 'service_unavailable'],
  ])('上游 %i 映射为 %s 并持久化', async (status, code) => {
    const qwen = provider(async () => new Response('', { status }));
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    await expect(qwen.result(jobId)).rejects.toMatchObject({ code });
    await expect(qwen.result(jobId)).rejects.toMatchObject({ code });
  });

  it('未配置密钥时不受理也不发起上游请求', async () => {
    const { calls, impl } = recording(async () => completion(JSON.stringify(collisionFieldDraft())));
    const qwen = createQwenProvider({ fetchImpl: impl, getKey: () => undefined, store: fakeStore() });
    expect(qwen.enabled()).toBe(false);
    await expect(qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM })).rejects.toMatchObject({ code: 'service_not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('续取沿模型降级链切换（同端点同密钥）', async () => {
    const { calls, impl } = recording((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const qwen = provider(impl, { callTimeoutMs: 20 });
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    await qwen.result(jobId);
    await qwen.result(jobId);
    await qwen.result(jobId);
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('qwen3.8-flash');
    expect(JSON.parse(String(calls[1].init.body)).model).toBe('qwen3.7-plus');
    expect(JSON.parse(String(calls[2].init.body)).model).toBe('qwen4-max');
  }, 15000);

  it('重提同题重置草稿类失败并重试，不再立即复用旧错误（DEF-038）', async () => {
    let round = 0;
    const { calls, impl } = recording(async () => {
      round += 1;
      return completion(JSON.stringify(round <= 2 ? badDraft() : collisionFieldDraft()));
    });
    const qwen = provider(impl);
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    await qwen.result(jobId);
    await expect(qwen.result(jobId)).rejects.toMatchObject({ code: 'ai_draft_invalid' });
    const again = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    expect(again.jobId).toBe(jobId);
    expect((await qwen.result(jobId)).status).toBe(200);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('单次调用超时先返回 pending 供续取，四次仍超时才持久化超时', async () => {
    const { calls, impl } = recording((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const qwen = provider(impl, { callTimeoutMs: 20 });
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    expect((await qwen.result(jobId)).status).toBe(202);
    expect((await qwen.result(jobId)).status).toBe(202);
    expect((await qwen.result(jobId)).status).toBe(202);
    await expect(qwen.result(jobId)).rejects.toMatchObject({ code: 'ai_timeout' });
    expect(calls).toHaveLength(4);
  }, 20000);

  it('超时失败后重新提交同题会重置任务并重试', async () => {
    let round = 0;
    const { calls, impl } = recording((_url, init) => {
      round += 1;
      if (round <= 4) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return Promise.resolve(completion(JSON.stringify(collisionFieldDraft())));
    });
    const qwen = provider(impl, { callTimeoutMs: 20 });
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    await qwen.result(jobId); await qwen.result(jobId); await qwen.result(jobId);
    await expect(qwen.result(jobId)).rejects.toMatchObject({ code: 'ai_timeout' });
    const again = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    expect(again.jobId).toBe(jobId);
    expect((await qwen.result(jobId)).status).toBe(200);
    expect(calls).toHaveLength(5);
  }, 20000);

  it('未知任务与非法任务标识分别 404/400', async () => {
    const qwen = provider(async () => completion(JSON.stringify(collisionFieldDraft())));
    await expect(qwen.result('a'.repeat(64))).rejects.toMatchObject({ code: 'job_not_found' });
    await expect(qwen.result('not-a-job')).rejects.toMatchObject({ code: 'invalid_job' });
  });

  it('重新生成标识产生新任务，不会续取已失败结果', async () => {
    const { calls, impl } = recording(async () => completion(JSON.stringify(badDraft())));
    const qwen = provider(impl);
    const first = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    const second = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM, generationId: 'regen-1' });
    expect(second.jobId).not.toBe(first.jobId);
    expect(second.resumed).toBe(false);
    await qwen.result(first.jobId);
    await expect(qwen.result(first.jobId)).rejects.toMatchObject({ code: 'ai_draft_invalid' });
    await qwen.result(second.jobId);
    await expect(qwen.result(second.jobId)).rejects.toMatchObject({ code: 'ai_draft_invalid' });
    expect(calls).toHaveLength(4);
  });

  it('超长失败回复不截断条件强行修正，直接持久化失败', async () => {
    const { calls, impl } = recording(async () => completion(' '.repeat(96001) + JSON.stringify(badDraft())));
    const qwen = provider(impl);
    const { jobId } = await qwen.start({ text: CORRECTED_COLLISION_FIELD_PROBLEM });
    expect((await qwen.result(jobId)).status).toBe(202);
    await expect(qwen.result(jobId)).rejects.toMatchObject({ code: 'ai_draft_invalid' });
    expect(calls).toHaveLength(1);
  });

  it('handler 在密钥存在时 POST 202、GET 流式终稿，缺失时仍走 Cloud Agents', async () => {
    const { impl } = recording(async () => completion(JSON.stringify(collisionFieldDraft())));
    const qwen = provider(impl);
    const forbidden = { client: () => { throw new Error('Cloud Agents must not be called'); }, qwen };
    const accepted = await handler(post({ text: CORRECTED_COLLISION_FIELD_PROBLEM }), forbidden);
    expect(accepted.status).toBe(202);
    const { jobId } = await accepted.json();
    const polled = await handler(new Request(`http://verification.local/functions/v1/app/interpret?job=${jobId}`), forbidden);
    expect(polled.status).toBe(200);
    const raw = await polled.text();
    expect(raw.startsWith(' ')).toBe(true);
    expect(JSON.parse(raw.trim()).scene.bodies[0].kind).toBe('ball');
    const cloud = createVerificationCloud(collisionFieldDraft());
    const legacy = await handler(post({ text: CORRECTED_COLLISION_FIELD_PROBLEM }), { client: () => cloud, qwen: createQwenProvider({ getKey: () => undefined, store: fakeStore() }) });
    expect(legacy.status).toBe(202);
    expect(cloud.sessions).toHaveLength(1);
  });

  it('诊断日志不含题面、草稿与密钥', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(line); });
    const { impl } = recording(async () => completion(JSON.stringify(collisionFieldDraft())));
    const qwen = provider(impl);
    const { jobId } = await qwen.start({ text: '秘密题面XYZ' });
    await qwen.result(jobId);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain('秘密题面XYZ');
      expect(line).not.toContain('test-key');
      expect(line).not.toContain('collisionRadius');
    }
  });

  it('客户端把流末凭据拒绝映射为可理解中文提示', async () => {
    const { readProblem } = await import('../src/ai/client');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('?job=')
      ? new Response(' {"ok":false,"error":"ai_provider_denied"}', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ ok: true, jobId: 'a'.repeat(64), resumed: false }), { status: 202, headers: { 'content-type': 'application/json' } })));
    await expect(readProblem({ text: CORRECTED_COLLISION_FIELD_PROBLEM, image: null, demo: 'collision-fields', pollIntervalMs: 1 }))
      .rejects.toThrow('读题 API 凭据无效');
  });
});