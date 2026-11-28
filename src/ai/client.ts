import type { SceneDraft } from '../model/types';
import { demoDraft, type DemoKind } from './demo';
import { parseSceneDraft } from '../model/runtime';
import { DraftContractError } from '../../functions/draft-schema';
import { SCENE_CONTRACT_HEADER, SCENE_CONTRACT_REVISION } from '../../functions/scene-contract';

const CONFIGURED_ENDPOINT = (import.meta as any).env?.VITE_AI_ENDPOINT as string | undefined;
const USE_DEMO = (import.meta as any).env?.VITE_AI_DEMO === '1';
/** 默认走 Sites 同源函数；VITE_AI_ENDPOINT 仅用于指向其他自建服务。 */
export const ENDPOINT = CONFIGURED_ENDPOINT || '/functions/v1/app/interpret';
export const MAX_IMAGE_BYTES = 600 * 1024;
/** 异步读题总预算：云端复杂题生成可达数分钟，浏览器轮询等待。 */
export const AI_TIMEOUT_MS = 360_000;
const FETCH_TIMEOUT_MS = 45_000;
/** 同步读题通道在一次 POST 内完成生成与修正；网关约 100 s 丢弃请求，留余量。 */
const POST_TIMEOUT_MS = 95_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_TRANSIENT_FAILURES = 3;

export const aiMode: 'remote' | 'demo' = USE_DEMO ? 'demo' : 'remote';

type ReadInput = {
  text: string;
  image: File | null;
  demo: DemoKind;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  generationId?: string;
  onProgress?: (info: { elapsedMs: number; phase?: 'generating' | 'repairing' }) => void;
};

export class AiDraftError extends Error {}

export class AiVersionMismatchError extends Error {
  constructor() {
    super('页面与读题服务的版本不一致，请按 Ctrl+F5 刷新页面后重试；若仍出现此提示，需要一起更新网页和读题服务。');
  }
}

function checkedDraft(data: Record<string, unknown>): SceneDraft {
  try {
    return parseSceneDraft(data);
  } catch (error) {
    if (!(error instanceof DraftContractError)) throw error;
    const reason = /bodies\.\d+\.kind/.test(error.message)
      ? '包含工作台不支持的物体类型'
      : '场景格式不完整或存在无效引用';
    throw new AiDraftError(`读题结果${reason}，请重新生成草稿。若刚更新过站点，请先按 Ctrl+F5 刷新页面。`);
  }
}

function mappedError(data: any, status: number): Error {
  if (status === 429) return new Error('今日读题额度已用尽：仍可继续手动搭建与计算');
  const code = data && typeof data.error === 'string' ? data.error : '';
  if (code === 'image_too_large') return new Error('题图超过读题服务 600 KB 上限，请压缩或改用截图后重试');
  if (code === 'scene_contract_mismatch') return new AiVersionMismatchError();
  if (code === 'ai_draft_invalid' || code === 'ai_draft_unparseable') {
    const reasons: Record<string, string> = {
      object_type: '对象类型有误', binding: '参数绑定有误', reference: '对象引用有误',
      field: '场参数格式有误', json: '返回格式有误', structure: '场景结构不完整',
    };
    const reason = typeof data?.diagnostic === 'string' ? reasons[data.diagnostic] : undefined;
    return new AiDraftError(`AI 未能返回可用的场景草稿${reason ? `（${reason}）` : ''}，请重新生成草稿。当前场景未被替换。`);
  }
  if (code === 'service_not_configured') return new Error('读题服务尚未配置云端凭据');
  if (code === 'ai_model_unavailable') return new Error('云端读题模型暂不可用（账号模型权限或额度可能已变化），手动搭建与计算不受影响，请稍后重试');
  if (code === 'ai_provider_denied') return new Error('读题 API 凭据无效或没有该模型权限，请检查站点 Secret 配置；手动搭建与计算不受影响');
  if (code === 'ai_timeout' || status === 504) return new Error('读题超时：请精简题面或稍后重试，手动搭建与计算不受影响');
  if (code === 'job_not_found') return new Error('读题任务已失效，请重新提交题目');
  return new Error(`读题服务暂不可用（HTTP ${status}${code ? ` · ${code}` : ''}），手动搭建与计算不受影响`);
}

async function responseError(resp: Response): Promise<Error> {
  const data = await resp.json().catch(() => null);
  return mappedError(data, resp.status);
}

function isTransient(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof Error && (error.message.startsWith('读题服务暂不可用') || error.message.startsWith('读题超时'));
}

export async function readProblem(input: ReadInput): Promise<SceneDraft> {
  if (input.image && input.image.size > MAX_IMAGE_BYTES) {
    throw new Error('题图超过 600 KB 上限，请压缩或裁剪后再上传');
  }
  if (input.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (aiMode === 'demo') return parseSceneDraft(demoDraft(input.demo, input.text));

  const body: any = { text: input.text, ...(input.generationId ? { generationId: input.generationId } : {}) };
  if (input.image) {
    const buf = await input.image.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    body.imageBase64 = btoa(binary);
    body.imageName = input.image.name;
  }

  const startedAt = Date.now();
  const deadline = startedAt + (input.timeoutMs ?? AI_TIMEOUT_MS);
  const pollInterval = input.pollIntervalMs ?? POLL_INTERVAL_MS;
  const source = { rawText: input.text, imageName: input.image?.name };

  const timedFetch = async (url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('读题超时：请精简题面或稍后重试，手动搭建与计算不受影响');
    // 每次请求独立控制器：一次超时不能污染后续轮询。
    const perFetch = new AbortController();
    const propagate = () => perFetch.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', propagate, { once: true });
    if (input.signal?.aborted) propagate();
    const timer = setTimeout(() => perFetch.abort(), Math.min(timeoutMs, remaining));
    try {
      const headers = new Headers(init?.headers);
      headers.set(SCENE_CONTRACT_HEADER, SCENE_CONTRACT_REVISION);
      const response = await fetch(url, { ...init, headers, cache: 'no-store', signal: perFetch.signal });
      const revision = response.headers.get(SCENE_CONTRACT_HEADER);
      if (revision && revision !== SCENE_CONTRACT_REVISION) throw new AiVersionMismatchError();
      return response;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', propagate);
    }
  };

  try {
    const resp = await timedFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, POST_TIMEOUT_MS);
    if (!resp.ok) throw await responseError(resp);
    let accepted: any;
    try {
      accepted = await resp.json();
    } catch {
      throw new Error('读题服务返回的不是有效 JSON，手动搭建与计算不受影响');
    }
    // 兼容直接返回草稿的旧服务端，以及同步通道流式 keepalive 后的终稿/错误 JSON。
    if (accepted && typeof accepted === 'object' && 'scene' in accepted) {
      return checkedDraft({ ...accepted, source });
    }
    if (accepted && typeof accepted === 'object' && typeof accepted.error === 'string') {
      throw mappedError(accepted, resp.status);
    }
    if (resp.status !== 202 || !accepted || typeof accepted.jobId !== 'string') {
      throw new Error('读题服务未返回任务标识，手动搭建与计算不受影响');
    }
    const resultUrl = `${ENDPOINT}?job=${encodeURIComponent(accepted.jobId)}`;
    let transientFailures = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      if (input.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      try {
        const poll = await timedFetch(resultUrl);
        // 同步/流式通道都把终稿、pending 或错误放在流末 JSON；先解析再分流。
        let state: any = null;
        try { state = await poll.json(); } catch { state = null; }
        if (state && typeof state === 'object' && state.pending) {
          transientFailures = 0;
          input.onProgress?.({ elapsedMs: Date.now() - startedAt, phase: state.phase === 'repairing' ? 'repairing' : 'generating' });
          continue;
        }
        if (state && typeof state === 'object' && typeof state.error === 'string') {
          throw mappedError(state, state.error === 'rate_limited' ? 429 : state.error === 'ai_timeout' ? 504 : 503);
        }
        if (!poll.ok) throw await responseError(poll);
        if (!state || typeof state !== 'object' || !('scene' in state)) throw new Error('服务返回缺少场景草稿');
        return checkedDraft({ ...state, source });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (isTransient(error) && transientFailures + 1 < MAX_TRANSIENT_FAILURES) {
          transientFailures += 1;
          continue;
        }
        throw error;
      }
    }
    throw new Error('读题超时：请精简题面或稍后重试，手动搭建与计算不受影响');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (input.signal?.aborted) throw error;
      throw new Error('读题请求超时：仍可继续手动搭建与计算');
    }
    if (error instanceof TypeError) throw new Error('无法连接读题服务，手动搭建与计算不受影响');
    throw error;
  }
}
