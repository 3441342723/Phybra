import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_TIMEOUT_MS, ENDPOINT, MAX_IMAGE_BYTES, readProblem } from '../src/ai/client';
import { demoDraft } from '../src/ai/demo';
import { parseSceneDraft } from '../src/model/runtime';

const TEXT = '倾角 30° 的斜面长 5 m，求到达底端时间。';
const validDraft = () => JSON.parse(JSON.stringify(demoDraft('incline', TEXT)));

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const input = (extra: Partial<Parameters<typeof readProblem>[0]> = {}) =>
  ({ text: TEXT, image: null, demo: 'incline' as const, pollIntervalMs: 1, ...extra });

const JOB = 'a'.repeat(64);
const accepted = () => jsonResponse({ ok: true, jobId: JOB, resumed: false }, 202);
const pending = () => jsonResponse({ ok: true, pending: true, jobId: JOB }, 202);

/** 受理 + 轮询的标准应答：POST 202，GET 先 pending 后草稿。 */
function asyncFlow(pendingCount = 0) {
  let polls = 0;
  return mockFetch(async (url, init) => {
    if ((init?.method ?? 'GET') === 'POST') return accepted();
    expect(url).toContain(`${ENDPOINT}?job=${JOB}`);
    polls += 1;
    return polls <= pendingCount ? pending() : jsonResponse(validDraft());
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('读题客户端边界', () => {
  it('默认请求同源 Function，超时预算大于服务端预算', () => {
    expect(ENDPOINT).toBe('/functions/v1/app/interpret');
    expect(AI_TIMEOUT_MS).toBeGreaterThanOrEqual(110_000);
  });

  it('合法响应通过运行时校验，source 用请求题面回填', async () => {
    const fetchSpy = mockFetch(async () => jsonResponse(validDraft()));
    const draft = await readProblem(input());
    expect(draft.scene.version).toBe(2);
    expect(draft.source.rawText).toBe(TEXT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).text).toBe(TEXT);
  });

  it('缺少字段的非法草稿被拒绝，不返回可渲染场景', async () => {
    const bad = validDraft();
    delete bad.unknown;
    mockFetch(async () => jsonResponse(bad));
    await expect(readProblem(input())).rejects.toThrow();
  });

  it('引用不存在的草稿路径被剔除并明示警告（DEF-042）', async () => {
    const bad = validDraft();
    bad.known[0].path = 'supports.doesNotExist.length';
    mockFetch(async () => jsonResponse(bad));
    const draft = await readProblem(input());
    expect(draft.known.some((k) => k.path === 'supports.doesNotExist.length')).toBe(false);
    expect(draft.warnings.some((w) => w.includes('无法定位'))).toBe(true);
  });

  it('非 JSON 响应给出可理解提示', async () => {
    mockFetch(async () => new Response('<html>502</html>', { status: 200 }));
    await expect(readProblem(input())).rejects.toThrow('不是有效 JSON');
  });

  it('429 提示额度用尽且不影响手动搭建', async () => {
    mockFetch(async () => jsonResponse({ ok: false, error: 'rate_limited' }, 429));
    await expect(readProblem(input())).rejects.toThrow('额度已用尽');
  });

  it.each([
    ['image_too_large', 413, '600 KB'],
    ['ai_draft_invalid', 502, '请重新生成草稿'],
    ['ai_draft_unparseable', 502, '请重新生成草稿'],
    ['service_not_configured', 503, '云端凭据'],
    ['ai_model_unavailable', 503, '模型暂不可用'],
    ['ai_timeout', 504, '读题超时'],
  ])('服务端错误码 %s 映射为可理解提示', async (code, status, fragment) => {
    mockFetch(async () => jsonResponse({ ok: false, error: code }, status));
    await expect(readProblem(input())).rejects.toThrow(fragment);
  });

  it('网关返回纯文本 504 时也提示读题超时', async () => {
    mockFetch(async () => new Response('upstream request timeout', { status: 504 }));
    await expect(readProblem(input())).rejects.toThrow('读题超时');
  });

  it('超过客户端上限的图片在本地拒绝，不发起请求', async () => {
    const fetchSpy = mockFetch(async () => jsonResponse(validDraft()));
    const image = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'big.png', { type: 'image/png' });
    await expect(readProblem(input({ image }))).rejects.toThrow('600 KB');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('合法图片以 base64 与文件名随请求发送', async () => {
    const fetchSpy = mockFetch(async () => jsonResponse(validDraft()));
    const image = new File([new Uint8Array([137, 80, 78, 71])], '题图.png', { type: 'image/png' });
    await readProblem(input({ image }));
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    expect(body.imageName).toBe('题图.png');
    expect(typeof body.imageBase64).toBe('string');
    expect(body.imageBase64.length).toBeGreaterThan(0);
  });

  it('已取消的请求立即抛出 AbortError，不发起网络调用', async () => {
    const fetchSpy = mockFetch(async () => jsonResponse(validDraft()));
    const controller = new AbortController();
    controller.abort();
    await expect(readProblem(input({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('请求中途取消时抛出 AbortError，迟到响应不会变成草稿', async () => {
    const controller = new AbortController();
    let settle: (response: Response) => void = () => {};
    let fail: (reason: unknown) => void = () => {};
    mockFetch((_url, init) => new Promise<Response>((resolve, reject) => {
      settle = resolve;
      fail = reject;
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = readProblem(input({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    settle(jsonResponse(validDraft()));
    fail(new DOMException('late', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('超时给出可理解提示而不是未处理拒绝', async () => {
    mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
    }));
    await expect(readProblem(input({ timeoutMs: 5 }))).rejects.toThrow('读题请求超时');
  });

  it('网络故障提示无法连接服务', async () => {
    mockFetch(async () => { throw new TypeError('Failed to fetch'); });
    await expect(readProblem(input())).rejects.toThrow('无法连接读题服务');
  });

  it('客户端校验与服务端契约一致：同一份草稿两边都接受', () => {
    expect(() => parseSceneDraft(validDraft())).not.toThrow();
  });

  it('受理后轮询取回草稿，source 用请求题面回填', async () => {
    const fetchSpy = asyncFlow(1);
    const draft = await readProblem(input());
    expect(draft.scene.version).toBe(2);
    expect(draft.source.rawText).toBe(TEXT);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
  });

  it('pending 期间上报进度', async () => {
    asyncFlow(2);
    const onProgress = vi.fn();
    await readProblem(input({ onProgress }));
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0][0].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('202 缺少 jobId 时给出可理解提示', async () => {
    mockFetch(async () => jsonResponse({ ok: true }, 202));
    await expect(readProblem(input())).rejects.toThrow('任务标识');
  });

  it('轮询阶段的错误码同样映射', async () => {
    mockFetch(async (_url, init) => ((init?.method ?? 'GET') === 'POST' ? accepted() : jsonResponse({ ok: false, error: 'ai_timeout' }, 504)));
    await expect(readProblem(input())).rejects.toThrow('读题超时');
  });

  it('job_not_found 提示重新提交', async () => {
    mockFetch(async (_url, init) => ((init?.method ?? 'GET') === 'POST' ? accepted() : jsonResponse({ ok: false, error: 'job_not_found' }, 404)));
    await expect(readProblem(input())).rejects.toThrow('已失效');
  });

  it('轮询中途取消时抛出 AbortError', async () => {
    const controller = new AbortController();
    mockFetch(async (_url, init) => {
      if ((init?.method ?? 'GET') === 'POST') return accepted();
      controller.abort();
      return pending();
    });
    await expect(readProblem(input({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('轮询瞬时网络故障可恢复', async () => {
    let polls = 0;
    mockFetch(async (_url, init) => {
      if ((init?.method ?? 'GET') === 'POST') return accepted();
      polls += 1;
      if (polls === 1) throw new TypeError('Failed to fetch');
      return jsonResponse(validDraft());
    });
    const draft = await readProblem(input());
    expect(draft.scene.version).toBe(2);
    expect(polls).toBe(2);
  });

  it('连续瞬时故障超过上限后提示无法连接', async () => {
    mockFetch(async (_url, init) => {
      if ((init?.method ?? 'GET') === 'POST') return accepted();
      throw new TypeError('Failed to fetch');
    });
    await expect(readProblem(input())).rejects.toThrow('无法连接读题服务');
  });

  it('总预算耗尽给出读题超时提示', async () => {
    mockFetch(async (_url, init) => ((init?.method ?? 'GET') === 'POST' ? accepted() : pending()));
    await expect(readProblem(input({ timeoutMs: 20 }))).rejects.toThrow('读题超时');
  });
});
