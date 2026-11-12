import { flatThrowExample, inclineExample } from '../model/factory';
import type { SceneDraft } from '../model/types';

/** 本地演示草稿：不调用任何云端服务，仅用于验证"AI 草稿 → 审阅 → 替换可撤销"流程 */
export function demoDraft(kind: 'incline' | 'flat', rawText: string): SceneDraft {
  if (kind === 'flat') {
    const scene = flatThrowExample();
    return {
      source: { rawText, demo: true },
      scene,
      known: [
        { path: 'bodies.0.pos.y', label: '抛出点高度', value: '20 m', quote: '从 20 m 高处水平抛出' },
        { path: 'bodies.0.vel.x', label: '水平初速度', value: '10 m/s', quote: '以 10 m/s 的水平速度抛出' },
      ],
      assumed: [
        { path: 'gravity', label: '重力加速度', value: '9.8 m/s²', basis: '常规取值，可改为 10' },
        { path: 'bodies.0.mass', label: '质点模型、忽略空气阻力', value: '—', basis: '抛体模板的基本假设' },
      ],
      unknown: [{ path: 'asks.landing', label: '待求：落地时间与水平射程' }],
      uncertain: [],
      warnings: ['演示模式：此草稿来自内置样例，并非 AI 识别结果'],
    };
  }
  const scene = inclineExample();
  const muPath = Object.keys(scene.bindings).find((p) => p.endsWith('mu_k'))!;
  const contactId = muPath.split('.')[1];
  const next = {
    ...scene,
    params: scene.params.filter((p) => p.name !== 'mu'),
    bindings: Object.fromEntries(Object.entries(scene.bindings).filter(([p]) => p !== muPath)),
    contacts: scene.contacts.map((c) => ({ ...c, mu_k: null })),
  };
  return {
    source: { rawText, demo: true },
    scene: next,
    known: [
      { path: 'supports.0.angleDeg', label: '斜面倾角', value: '30°', quote: '倾角为 30° 的斜面' },
      { path: 'supports.0.length', label: '斜面长度', value: '5 m', quote: '斜面长 5 m' },
      { path: `contacts.${contactId}.mu_s`, label: '静摩擦因数', value: '0.4', quote: '静摩擦因数为 0.4' },
      { path: 'bodies.0.attach.s', label: '初始位置', value: '顶端（s=5 m）', quote: '物体自斜面顶端由静止释放' },
    ],
    assumed: [
      { path: 'gravity', label: '重力加速度', value: '9.8 m/s²', basis: '常规取值' },
      { path: 'bodies.0.mass', label: '物体视为质点', value: '—', basis: '斜面模板的基本假设' },
    ],
    unknown: [{ path: `contacts.${contactId}.mu_k`, label: '动摩擦因数：题目未给出，保留为空，需用户补充' }],
    uncertain: [`contacts.${contactId}.mu_s`],
    warnings: ['演示模式：此草稿来自内置样例，并非 AI 识别结果；μ_k 故意留空以演示"不编造物理参数"'],
  };
}
