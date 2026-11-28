import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../functions/handler';
import { startInterpret, interpretResult, parseInterpretInput } from '../functions/interpret';
import { repairContent, unfinishedJson } from '../functions/draft-repair';
import { createVerificationCloud } from '../dev/verification-cloud';
import { AiDraftError, readProblem } from '../src/ai/client';
import { collisionFieldDraft, CORRECTED_COLLISION_FIELD_PROBLEM } from '../src/ai/collision-field-example';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const input = { text: CORRECTED_COLLISION_FIELD_PROBLEM, image: null, demo: 'collision-fields' as const, pollIntervalMs: 1 };
const badDraft = () => { const d: any = collisionFieldDraft(); d.scene.bodies[0].kind = 'sphere'; return d; };
function connect(cloud: ReturnType<typeof createVerificationCloud>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
    handler(new Request(new URL(url, 'http://verification.local'), init), { client: () => cloud })));
}

describe('无效 AI 草稿的受控恢复', () => {
  it('格式错误自动修正一次后通过真实客户端，不替换成本地示例', async () => {
    const cloud = createVerificationCloud(badDraft(), { repairReply: collisionFieldDraft() });
    connect(cloud);
    const progress = vi.fn();
    const draft = await readProblem({ ...input, onProgress: progress });
    expect(draft.scene.bodies[0].kind).toBe('ball');
    expect(draft.scene.bodies[0].charge).toBe(.0001);
    expect(draft.stages![1].scene.fields).toHaveLength(3);
    expect(draft.source.demo).toBeUndefined();
    expect(draft.source.rawText).toBe(input.text);
    expect(draft.warnings.at(-1)).toContain('自动修正一次');
    expect(progress.mock.calls.some(([state]) => state.phase === 'repairing')).toBe(true);
    expect(cloud.sessions).toHaveLength(2); expect(cloud.prompts).toHaveLength(2);
    const repairPrompt = JSON.stringify(cloud.prompts[1]);
    expect(repairPrompt).toContain(input.text); expect(repairPrompt).toContain('bodies.0.kind');
    expect(repairPrompt).toContain('不要为了通过校验删除条件');
    await readProblem(input);
    expect(cloud.sessions).toHaveLength(2); expect(cloud.prompts).toHaveLength(2);
  });

  it('修正仍失败时停止，返回明确原因类别，反复轮询不会无限创建任务', async () => {
    const cloud = createVerificationCloud(badDraft());
    const job = (await startInterpret(cloud, { text: input.text })).jobId;
    expect((await interpretResult(cloud, job)).body.phase).toBe('repairing');
    for (let n = 0; n < 3; n++) {
      const response = await handler(new Request(`http://verification.local/interpret?job=${job}`), { client: () => cloud });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ ok: false, error: 'ai_draft_invalid', diagnostic: 'object_type' });
    }
    expect(cloud.sessions).toHaveLength(2); expect(cloud.prompts).toHaveLength(2);
    connect(cloud);
    await expect(readProblem(input)).rejects.toBeInstanceOf(AiDraftError);
    await expect(readProblem(input)).rejects.not.toThrow('补全题面');
  });

  it('并发轮询只产生一个修正任务', async () => {
    const cloud = createVerificationCloud(badDraft(), { repairReply: collisionFieldDraft() });
    const { jobId } = await startInterpret(cloud, { text: input.text });
    await Promise.all([interpretResult(cloud, jobId), interpretResult(cloud, jobId), interpretResult(cloud, jobId)]);
    expect(cloud.sessions).toHaveLength(2); expect(cloud.prompts).toHaveLength(2);
    expect((await interpretResult(cloud, jobId)).status).toBe(200);
  });

  it('仍在传输的 JSON 等待完整回复，不报错也不触发修正', async () => {
    const cloud = createVerificationCloud(collisionFieldDraft());
    const request = cloud.request.bind(cloud);
    let partial = true;
    vi.spyOn(cloud, 'request').mockImplementation(async (path, options) => {
      const result: any = await request(path, options);
      if (partial && path.includes('/events?')) result.data.find((e: any) => e.type === 'agent.message').content[0].text = '{"scene":{"title":"半';
      return result;
    });
    const { jobId } = await startInterpret(cloud, { text: input.text });
    expect((await interpretResult(cloud, jobId)).status).toBe(202);
    expect(cloud.sessions).toHaveLength(1);
    partial = false;
    expect((await interpretResult(cloud, jobId)).status).toBe(200);
    expect(cloud.prompts).toHaveLength(1);
  });

  it('永久不完整回复按超时处理，不通过无限修正掩盖', async () => {
    const cloud = createVerificationCloud('{"scene":');
    const { jobId } = await startInterpret(cloud, { text: input.text });
    cloud.sessions[0].created_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await expect(interpretResult(cloud, jobId)).rejects.toMatchObject({ code: 'ai_timeout' });
    expect(cloud.sessions).toHaveLength(1);
  });

  it('重新生成使用独立标识，同题续取仍复用原任务', async () => {
    const cloud = createVerificationCloud(collisionFieldDraft());
    const first = await startInterpret(cloud, { text: input.text });
    expect((await startInterpret(cloud, { text: input.text })).jobId).toBe(first.jobId);
    const retry = await startInterpret(cloud, { text: input.text, generationId: 'retry-1' });
    expect(retry.jobId).not.toBe(first.jobId);
    expect((await startInterpret(cloud, { text: input.text, generationId: 'retry-1' })).jobId).toBe(retry.jobId);
    expect(cloud.sessions).toHaveLength(2); expect(cloud.prompts).toHaveLength(2);
  });

  it.each([null, 123, '', 'a'.repeat(81), '../bad'])('拒绝非法重新生成标识 %s', generationId => {
    expect(() => parseInterpretInput({ text: input.text, generationId })).toThrow();
  });

  it('题图随原始题面交给修正请求，浏览器结果不暴露原始草稿', async () => {
    const cloud = createVerificationCloud(badDraft(), { repairReply: collisionFieldDraft() });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const { jobId } = await startInterpret(cloud, { text: input.text, imageBase64: png, imageName: '题图.png' });
    await interpretResult(cloud, jobId);
    const result = await interpretResult(cloud, jobId);
    expect(JSON.stringify(cloud.prompts[1])).toContain(png);
    expect(JSON.stringify(result.body)).not.toContain(png);
    expect(JSON.stringify(result.body)).not.toContain('"kind":"sphere"');
    expect(result.body.source).toEqual({ imageName: '题图.png' });
  });

  it('修正失败日志只记录原因类别，不记录原题或错误路径中的模型原文', async () => {
    const marker = 'PRIVATE-PROBLEM-PATH-MARKER';
    const draft = collisionFieldDraft(); draft.known[0].path = marker;
    const cloud = createVerificationCloud(draft);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { jobId } = await startInterpret(cloud, { text: '原题隐私文字' });
    await interpretResult(cloud, jobId);
    await expect(interpretResult(cloud, jobId)).rejects.toMatchObject({ code: 'ai_draft_invalid', status: 502 });
    const text = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(text).not.toContain(marker); expect(text).not.toContain('原题隐私文字');
  });

  it('超过云端请求上限时不截断题图或条件来强行修正', () => {
    const original = [{ type: 'image', source: { data: 'A'.repeat(819200) } }];
    expect(repairContent(original, '题'.repeat(95000), 'structure')).toBeNull();
    expect(repairContent(original, '{}', 'structure')).not.toBeNull();
    expect(repairContent([], '{}', 'structure')).toBeNull();
  });
});

describe('JSON 流结束判断', () => {
  it.each(['{"a":', '```json\n{"a":"unfinished', '[{"a":1}', '{"a":"escaped\\"'])('未结束：%s', text => {
    expect(unfinishedJson(text)).toBe(true);
  });
  it.each(['{"a":"}","b":[]}', '```json\n{"a":1}\n```', '{"a":}', '无法建模', '{]'])('完整或已确定非法：%s', text => {
    expect(unfinishedJson(text)).toBe(false);
  });
});
