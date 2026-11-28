import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../functions/handler';
import { SCENE_CONTRACT_HEADER, SCENE_CONTRACT_REVISION } from '../functions/scene-contract';
import { createVerificationCloud } from '../dev/verification-cloud';
import { collisionFieldDraft, CORRECTED_COLLISION_FIELD_PROBLEM } from '../src/ai/collision-field-example';
import { AiVersionMismatchError, ENDPOINT, readProblem } from '../src/ai/client';
import { resolveDraftStage } from '../src/ai/stages';
import { solve } from '../src/solver';
import { answer, ok } from './helpers';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const input = { text: CORRECTED_COLLISION_FIELD_PROBLEM, image: null, demo: 'collision-fields' as const, pollIntervalMs: 1 };

describe('截图中的复合题经过实际客户端和 Function', () => {
  it('POST→GET→ball 草稿→阶段应用→三阶段求解，电荷与场不丢失', async () => {
    const cloud = createVerificationCloud(collisionFieldDraft());
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const request = new Request(new URL(url, 'http://verification.local'), init);
      requests.push(request.clone());
      return handler(request, { client: () => cloud });
    }));
    const draft = await readProblem(input);
    expect(requests.map(r => r.method)).toEqual(['POST', 'GET']);
    for (const request of requests) {
      expect(request.headers.get(SCENE_CONTRACT_HEADER)).toBe(SCENE_CONTRACT_REVISION);
      expect(request.cache).toBe('no-store');
    }
    expect((await requests[0].json()).text).toBe(input.text);
    expect(draft.source).toEqual({ rawText: input.text, imageName: undefined });
    expect(draft.source.demo).toBeUndefined();
    expect(draft.scene.bodies.map(b => b.kind)).toEqual(['ball', 'ball']);
    expect(draft.scene.bodies[0].charge).toBe(.0001);
    const impact = ok(solve(draft.scene));
    expect(answer(impact, 'A.after.vx').value).toBeCloseTo(15 / 7);
    expect(answer(impact, 'B.after.vx').value).toBeCloseTo(50 / 7);
    const field = resolveDraftStage(draft, 'a-field');
    expect(field.fields).toHaveLength(3);
    const fieldSolution = ok(solve(field));
    expect(answer(fieldSolution, field.asks[1].id + '.y').value).toBeCloseTo(.8 + 60000 / 7);
    const flight = resolveDraftStage(draft, 'b-flight');
    const flightSolution = ok(solve(flight));
    expect(flightSolution.evalAt(.4).x).toBeCloseTo(20 / 7);
    expect(flightSolution.evalAt(.4).y).toBeCloseTo(0);
  });

  it('不一致的客户端版本在调用云端前拒绝，返回明确的更新提示', async () => {
    const cloud = createVerificationCloud(collisionFieldDraft());
    const request = new Request('http://verification.local' + ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json', [SCENE_CONTRACT_HEADER]: 'old-version' },
      body: JSON.stringify({ text: input.text }),
    });
    const response = await handler(request, { client: () => cloud });
    expect(response.status).toBe(409);
    expect(response.headers.get(SCENE_CONTRACT_HEADER)).toBe(SCENE_CONTRACT_REVISION);
    expect((await response.json()).error).toBe('scene_contract_mismatch');
    expect(cloud.calls).toHaveLength(0);
  });

  it.each(['POST', 'GET'])('%s 响应版本不一致时不能进入草稿或重复请求', async method => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (method === 'GET' && init?.method === 'POST') return Response.json({ jobId: 'a'.repeat(64) }, { status: 202 });
      return Response.json(collisionFieldDraft(), { headers: { [SCENE_CONTRACT_HEADER]: 'old-server-version' } });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(readProblem(input)).rejects.toBeInstanceOf(AiVersionMismatchError);
    expect(fetch).toHaveBeenCalledTimes(method === 'POST' ? 1 : 2);
  });

  it('合法 ball 可从旧的无版本头服务读取，未知类型仍拒绝并给出中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(collisionFieldDraft())));
    expect((await readProblem(input)).scene.bodies[0].kind).toBe('ball');
    const invalid: any = collisionFieldDraft(); invalid.scene.bodies[0].kind = 'unrecognized-object';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(invalid)));
    await expect(readProblem(input)).rejects.toThrow('不支持的物体类型');
    await expect(readProblem(input)).rejects.not.toThrow('bodies.0.kind');
  });

  it('网关未保留版本响应头时仍识别服务端的版本错误码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'scene_contract_mismatch' }, { status: 409 })));
    await expect(readProblem(input)).rejects.toBeInstanceOf(AiVersionMismatchError);
  });

  it('云端给出真正未知的类型时由服务端拒绝，不当作合法小球应用', async () => {
    const draft: any = collisionFieldDraft(); draft.scene.bodies[0].kind = 'unknown-body';
    const cloud = createVerificationCloud(draft);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
      handler(new Request(new URL(url, 'http://verification.local'), init), { client: () => cloud })));
    await expect(readProblem(input)).rejects.toThrow('请重新生成草稿');
    expect(cloud.prompts).toHaveLength(2);
  });
});
