import type { Ask, CheckReport, Scene } from './types';

const ASK_LABEL: Record<string, string> = {
  at_time: '指定时刻的状态', at_height: '到达指定高度的时刻', at_position: '到达指定位置的时刻',
  at_velocity: '达到指定速度的时刻', landing: '落地', apex: '最高点', rest: '速度为零',
  end_of_support: '到达支撑面端点', friction_state: '摩擦与运动状态',
  energy_at: '某时刻的能量', work_between: '两时刻之间的做功与耗散',
  field_exit: '首次离开场区',
  field_entry: '首次进入场区',
  collision: '碰撞时刻与碰前碰后状态',
  motion_analysis:'场中运动性质、回旋半径与周期',
  return_to_initial_x:'首次返回初始位置的竖直线',
  custom:'保留的题目待求（尚无专用求解）',
};

export function askLabel(ask: Pick<Ask, 'kind'>): string {
  return ASK_LABEL[ask.kind] ?? ask.kind;
}

/** 结构与白名单校验：与具体题型无关，AI 草稿与手动编辑共用 */
export function validateScene(scene: Scene): CheckReport {
  const blockers: CheckReport['blockers'] = [];
  const pending: CheckReport['pending'] = [];
  const push = (code: any, path: string, message: string) => blockers.push({ code, path, message });
  if (scene.dimension !== undefined && scene.dimension !== '2d' && scene.dimension !== '3d') push('unsupported_combo','dimension','无法识别坐标维度。');
  if(scene.dimension!=='3d') {
    // null 是 AI 草稿的“无此分量”占位，与 undefined 同义，不算三维分量。
    const nonzero=(value:unknown)=>value!==undefined&&value!==null&&value!==0;
    for(const b of scene.bodies) {
      if(nonzero(b.pos.z)||nonzero(b.vel.z))push('unsupported_combo','bodies.'+b.id+'.pos.z','此物体有空间位置或速度，请启用三维坐标，或在三维属性中将 z、vz 设为 0。');
    }
    for(const f of scene.fields??[]) {
      if(f.enabled&&[f.position.z,f.vector.z,f.bx,f.by,f.gradient?.z].some(nonzero))push('unsupported_combo','fields.'+f.id,'此场有三维分量，请启用三维坐标，或在三维属性中将新增分量设为 0。');
    }
  }

  if (scene.bodies.length === 0) push('missing_required', 'bodies', '场景为空：请添加一个物体，或使用 AI 建模');
  if (scene.bodies.length > 1 && !(scene.bodies.length === 2 && scene.bodies.every(b=>b.kind==='ball'))) push('unsupported_combo', 'bodies', '多物体目前支持两个小球的光滑碰撞。');
  // A custom-only scene is intentionally preserved for an unsupported topic
  // (for example a spring). Do not add unrelated gravity blockers that would
  // make it look as if the user had supplied an invalid physical value.
  const customOnlyQuery = scene.asks.length > 0 && scene.asks.every((ask) => ask.kind === 'custom');
  if (scene.bodies.some(b => b.kind !== 'ball')) {
    if (!customOnlyQuery) {
      if (scene.gravity === null) push('missing_required', 'gravity', '缺少重力加速度 g（可填 9.8 或 10）');
      // 水平面内圆周运动可忽略重力（g=0）；其余非小球题型仍需正重力。
      else if (scene.gravity < 0 || (scene.gravity === 0 && !scene.bodies.every(b => b.kind === 'circular'))) push('constraint_conflict', 'gravity', 'g 必须为正数');
    }
    if (scene.fields?.some(f => f.enabled) || scene.links?.some(l => l.bodyId !== null)) {
      push('unsupported_combo', 'bodies', '独立场和定点绳杆请搭配小球。');
    }
  }

  const frictionOnlyQuery = scene.asks.length > 0 && scene.asks.every((ask) => ask.kind === 'friction_state');
  for (const sup of scene.supports) {
    if (sup.angleDeg === null || !Number.isFinite(sup.angleDeg)) push('missing_required', `supports.${sup.id}.angleDeg`, '请填写倾角，水平面填 0°');
    else if (Math.abs(sup.angleDeg) >= 90) push('unsupported_combo', `supports.${sup.id}.angleDeg`, '首版不支持 |倾角| ≥ 90°');
    // 仅判断静摩擦是否足以自锁时不需要知道支撑面长度；
    // 其他运动、端点和能量查询仍要求有限的支撑面长度。
    if (sup.length === null && !frictionOnlyQuery && !customOnlyQuery) push('missing_required', `supports.${sup.id}.length`, '缺少支撑面长度');
    else if (sup.length !== null && sup.length <= 0) push('constraint_conflict', `supports.${sup.id}.length`, '长度必须为正');
  }

  for (const body of scene.bodies) {
    if (body.kind === 'block') {
      if (!body.attach) push('unsupported_combo', `bodies.${body.id}`, '物块需要依附于水平面或斜面；自由运动请使用小球');
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
    if (body.kind !== 'block' && body.attach) {
      push('constraint_conflict', `bodies.${body.id}.attach`, '此物体不能依附于支撑面');
    }
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
  { id: 'composition', label: '运动的合成与分解（小船渡河：最短时间/最短位移）' },
  { id: 'circular', label: '匀速圆周运动（线速度/角速度/周期/向心加速度/向心力）' },
  { id: 'field', label: '小球与场（重力、电场、磁场、点源）及单根定点绳杆' },
  { id: 'field-3d', label: '单小球三维自由运动（全局重力、电场、匀强磁场、点源，可叠加）' },
  { id: 'collision', label: '两个小球的弹性/非弹性正碰、追碰与二维斜碰（无外场、无转动）' },
];
