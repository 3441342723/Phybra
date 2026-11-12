import type { Ask, CheckReport, Scene } from './types';

const ASK_LABEL: Record<string, string> = {
  at_time: '指定时刻的状态', at_height: '到达指定高度的时刻', at_position: '到达指定位置的时刻',
  at_velocity: '达到指定速度的时刻', landing: '落地', apex: '最高点', rest: '速度为零',
  end_of_support: '到达支撑面端点', friction_state: '摩擦与运动状态',
};

export function askLabel(ask: Ask): string {
  return ASK_LABEL[ask.kind] ?? ask.kind;
}

/** 结构与白名单校验：与具体题型无关，AI 草稿与手动编辑共用 */
export function validateScene(scene: Scene): CheckReport {
  const blockers: CheckReport['blockers'] = [];
  const pending: CheckReport['pending'] = [];
  const push = (code: any, path: string, message: string) => blockers.push({ code, path, message });

  if (scene.bodies.length === 0) push('missing_required', 'bodies', '场景为空：请添加一个物体，或使用 AI 建模');
  if (scene.bodies.length > 1) push('unsupported_combo', 'bodies', '首版仅支持单物体；连接体将在后续模块开放');
  if (scene.gravity === null) push('missing_required', 'gravity', '缺少重力加速度 g（可填 9.8 或 10）');
  else if (scene.gravity <= 0) push('constraint_conflict', 'gravity', 'g 必须为正数');

  for (const sup of scene.supports) {
    if (sup.kind === 'horizontal' && sup.angleDeg !== 0) push('constraint_conflict', `supports.${sup.id}.angleDeg`, '水平面的倾角必须为 0°');
    if (sup.kind === 'incline' && (sup.angleDeg === null || Math.abs(sup.angleDeg) < 1e-9)) {
      push('constraint_conflict', `supports.${sup.id}.angleDeg`, '斜面需要非零倾角；水平面请使用“水平面”对象');
    }
    if (sup.angleDeg !== null && Math.abs(sup.angleDeg) >= 90) push('unsupported_combo', `supports.${sup.id}.angleDeg`, '首版不支持 |倾角| ≥ 90°');
    if (sup.length === null) push('missing_required', `supports.${sup.id}.length`, '缺少支撑面长度');
    else if (sup.length <= 0) push('constraint_conflict', `supports.${sup.id}.length`, '长度必须为正');
  }

  for (const body of scene.bodies) {
    if (body.kind === 'block') {
      if (!body.attach) push('unsupported_combo', `bodies.${body.id}`, '滑块需要依附于水平面或斜面；自由抛掷请使用“抛体”');
      else {
        const sup = scene.supports.find((s) => s.id === body.attach!.support);
        if (!sup) push('constraint_conflict', `bodies.${body.id}.attach`, '依附的支撑面不存在');
        else if (body.attach.s !== null && sup.length !== null && (body.attach.s < -1e-9 || body.attach.s > sup.length + 1e-9)) {
          push('constraint_conflict', `bodies.${body.id}.attach.s`, '物体不在支撑面范围内');
        }
        if (!scene.contacts.some((c) => c.body === body.id)) {
          push('missing_required', `bodies.${body.id}`, '缺少摩擦接触设置（光滑请把 μ 填为 0）');
        }
      }
    }
    if (body.kind === 'projectile' && body.attach) push('constraint_conflict', `bodies.${body.id}.attach`, '抛体不能依附于支撑面');
    if (body.mass === null && body.kind === 'block') pending.push({ path: `bodies.${body.id}.mass`, label: '质量未赋值：首批题型的结果与质量无关' });
    if (body.kind === 'block' && body.vel.y !== null && Math.abs(body.vel.y) > 1e-9) {
      pending.push({ path: `bodies.${body.id}.vel`, label: '沿面运动只取初速度沿面分量，垂直分量被忽略' });
    }
  }

  for (const contact of scene.contacts) {
    if (contact.mu_k !== null && contact.mu_s !== null && contact.mu_k > contact.mu_s + 1e-12) {
      push('constraint_conflict', `contacts.${contact.id}.mu_k`, '动摩擦因数大于静摩擦因数，条件自相矛盾');
    }
    for (const key of ['mu_s', 'mu_k'] as const) {
      const v = contact[key];
      if (v !== null && v < 0) push('constraint_conflict', `contacts.${contact.id}.${key}`, '摩擦因数不能为负');
    }
  }

  for (const ask of scene.asks) {
    const need = ask.kind === 'at_time' ? 't' : ask.kind === 'at_height' ? 'y' : ask.kind === 'at_position' ? 'x' : ask.kind === 'at_velocity' ? 'v' : null;
    if (need && ask[need] === null) push('missing_required', `asks.${ask.id}.${need}`, `「${askLabel(ask)}」缺少目标数值`);
  }

  return { blockers, pending };
}

export const SUPPORTED_TYPES = [
  { id: 'kinematics-1d', label: '匀变速直线运动（含水平面摩擦）' },
  { id: 'projectile', label: '平抛与斜抛' },
  { id: 'incline-friction', label: '单物体斜面与摩擦（可连接水平面/斜面形成连续轨道，运动截至外端点）' },
];
