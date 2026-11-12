import type { SceneDraft } from '../model/types';
import { demoDraft } from './demo';

const ENDPOINT = (import.meta as any).env?.VITE_AI_ENDPOINT as string | undefined;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const aiMode: 'remote' | 'demo' = ENDPOINT ? 'remote' : 'demo';

export async function readProblem(input: { text: string; image: File | null; demo: 'incline' | 'flat' }): Promise<SceneDraft> {
  if (input.image && input.image.size > MAX_IMAGE_BYTES) {
    throw new Error('图片超过 4 MB，请压缩后再上传');
  }
  if (!ENDPOINT) return demoDraft(input.demo, input.text);
  const body: any = { text: input.text };
  if (input.image) {
    const buf = await input.image.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    body.imageBase64 = btoa(binary);
    body.imageName = input.image.name;
  }
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    if (resp.status === 429) throw new Error('今日读题额度已用尽：仍可继续手动搭建与计算');
    throw new Error(`读题服务暂不可用（HTTP ${resp.status}），手动搭建与计算不受影响`);
  }
  const data = await resp.json();
  if (!data?.scene) throw new Error('服务返回缺少场景草稿');
  return { ...data, source: { rawText: input.text, imageName: input.image?.name } } as SceneDraft;
}
