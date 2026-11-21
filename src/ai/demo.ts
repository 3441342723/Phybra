import { ELECTROMAGNETIC_EXAMPLES, flatThrowExample, inclineExample } from '../model/factory';
import type { SceneDraft } from '../model/types';

export type DemoKind = 'incline' | 'flat' | 'plates';
export const PLATES_PROBLEM = '质量为 2 kg、电荷量为 +1 C 的小球从左板处静止释放。两板间距为 6 m，左板电势比右板高 12 V。不计重力和边缘效应，求小球到达右板的时间、速度和电场做功。';

/** 本地演示草稿：不调用任何云端服务，仅用于验证"AI 草稿 → 审阅 → 替换可撤销"流程 */
export function demoDraft(kind: DemoKind, rawText: string): SceneDraft {
  if (kind === 'plates') {
    const scene = ELECTROMAGNETIC_EXAMPLES.find(example => example.id === 'parallel-plate-acceleration')!.build();
    const body = 'bodies.' + scene.bodies[0].id;
    const field = 'fields.' + scene.fields![0].id;
    return {
      source: { rawText: PLATES_PROBLEM, demo: true },
      scene,
      known: [
        { path: body + '.mass', label: '质量', value: '2 kg', quote: '质量为 2 kg' },
        { path: body + '.charge', label: '电荷量', value: '+1 C', quote: '电荷量为 +1 C' },
        { path: body + '.vel', label: '初速度', value: '0 m/s', quote: '从左板处静止释放' },
        { path: field + '.shape.width', label: '板间距', value: '6 m', quote: '两板间距为 6 m' },
        { path: field + '.plates.voltage', label: '左板相对于右板的电压', value: '+12 V', quote: '左板电势比右板高 12 V' },
      ],
      assumed: [{
        path: field + '.shape', label: '板间电场视为匀强', value: '沿 +x 方向', basis: '取向右为正，按题意忽略边缘效应和重力。',
      }],
      unknown: scene.asks.map(ask => ({
        path: 'asks.' + ask.id, label: ask.kind === 'field_exit' ? '到达右板的时间和速度' : '到达右板前电场做功',
      })),
      uncertain: [],
      warnings: ['演示模式：此草稿来自内置样例，并非 AI 识别结果'],
    };
  }
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
