import type { SceneDraft } from '../model/types';
import { demoDraft, type DemoKind } from './demo';
import { parseSceneDraft } from '../model/runtime';

const CONFIGURED_ENDPOINT = (import.meta as any).env?.VITE_AI_ENDPOINT as string | undefined;
const USE_DEMO = (import.meta as any).env?.VITE_AI_DEMO === '1';
/** 默认走 Sites 同源函数；VITE_AI_ENDPOINT 仅用于指向其他自建服务。 */
export const ENDPOINT = CONFIGURED_ENDPOINT || '/functions/v1/app/interpret';
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const AI_TIMEOUT_MS = 120_000;

export const aiMode: 'remote' | 'demo' = USE_DEMO ? 'demo' : 'remote';

export async function readProblem(input: { text: string; image: File | null; demo: DemoKind; signal?: AbortSignal; timeoutMs?: number }): Promise<SceneDraft> {
  if (input.image && input.image.size > MAX_IMAGE_BYTES) {
    throw new Error('图片超过 4 MB，请压缩后再上传');
  }
  if (input.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (aiMode === 'demo') return parseSceneDraft(demoDraft(input.demo, input.text));
  const body: any = { text: input.text };
  if (input.image) {
    const buf = await input.image.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    body.imageBase64 = btoa(binary);
    body.imageName = input.image.name;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? AI_TIMEOUT_MS);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      if (resp.status === 429) throw new Error('今日读题额度已用尽：仍可继续手动搭建与计算');
      const code: string = await resp.json()
        .then((data) => (data && typeof data === 'object' && typeof (data as any).error === 'string' ? (data as any).error : ''))
        .catch(() => '');
      if (code === 'image_too_large') throw new Error('题图超过读题服务 600 KB 上限，请压缩或改用截图后重试');
      if (code === 'ai_draft_invalid' || code === 'ai_draft_unparseable') throw new Error('读题结果不符合场景契约，请补全题面文字后重试');
      if (code === 'service_not_configured') throw new Error('读题服务尚未配置云端凭据');
      if (code === 'ai_timeout' || resp.status === 504) throw new Error('读题超时：请精简题面或稍后重试，手动搭建与计算不受影响');
      throw new Error(`读题服务暂不可用（HTTP ${resp.status}${code ? ` · ${code}` : ''}），手动搭建与计算不受影响`);
    }
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      throw new Error('读题服务返回的不是有效 JSON，手动搭建与计算不受影响');
    }
    if (!data || typeof data !== 'object' || !('scene' in data)) throw new Error('服务返回缺少场景草稿');
    return parseSceneDraft({ ...(data as Record<string, unknown>), source: { rawText: input.text, imageName: input.image?.name } });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (input.signal?.aborted) throw error;
      throw new Error('读题请求超时：仍可继续手动搭建与计算');
    }
    if (error instanceof TypeError) throw new Error('无法连接读题服务，手动搭建与计算不受影响');
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
