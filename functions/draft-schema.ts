// Shared browser / Function contract; self-contained for Sites packaging.

export class DraftContractError extends Error {}

export const UNIT_KINDS = ['length', 'time', 'speed', 'accel', 'mass', 'angle', 'charge', 'electric', 'magnetic', 'voltage', 'gravity_gradient', 'electric_gradient', 'magnetic_gradient', 'none'];
export const ASK_KINDS = ['at_time', 'at_height', 'at_position', 'at_velocity', 'landing', 'apex', 'rest', 'end_of_support', 'friction_state', 'energy_at', 'work_between', 'field_entry', 'field_exit', 'collision', 'motion_analysis', 'return_to_initial_x', 'custom'];
const COLLECTIONS = ['bodies', 'supports', 'contacts', 'asks', 'params', 'fields', 'links', 'stages'];
const EVENTS = ['initial','apex','landing','end_of_support','final_rest','field_exit','collision'];
const FORBIDDEN = ['__proto__','prototype','constructor'];

function keys(row: Record<string,unknown>, allowed: string[], path: string): void {
  for(const key of Object.keys(row))if(!allowed.includes(key))fail(`${path}.${key} 不是已定义字段，不能静默丢弃题目条件`);
}

function vector(value: unknown, path: string, nullable=false, spatial=false): void {
  const v=asObject(value,path);
  // null z is an absent-component placeholder, not a third dimension.
  if(!spatial&&v.z===null)delete v.z;
  keys(v,spatial?['x','y','z']:['x','y'],path);
  const number=nullable?asNullableFinite:asFinite;
  number(v.x,path+'.x');number(v.y,path+'.y');
  if(v.z!==undefined&&v.z!==null){if(!spatial)fail(path+'.z 不属于二维向量');number(v.z,path+'.z');}
}

function energyPoint(value: unknown, path: string):void {
  const p=asObject(value,path);
  if(p.kind==='time'){keys(p,['kind','t'],path);asNullableFinite(p.t,path+'.t');}
  else if(p.kind==='event'){keys(p,['kind','event'],path);if(!EVENTS.includes(p.event as string))fail(path+'.event 无效');}
  else fail(path+'.kind 无效');
}

function fail(message: string): never {
  throw new DraftContractError(message);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} 必须是对象`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(`${path} 必须是字符串`);
  return value;
}

function asFinite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} 必须是有限数字`);
  return value;
}

function asNullableFinite(value: unknown, path: string): number | null {
  return value === null ? null : asFinite(value, path);
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} 必须是数组`);
  return value;
}

function uniqueIds(items: Record<string, unknown>[], path: string): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const id = asString(item.id, `${path}.${index}.id`);
    if (seen.has(id)) fail(`${path} 包含重复 id：${id}`);
    seen.add(id);
  });
}

function resolveField(scene: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  if (parts.length < 1 || parts[0] === 'bindings' || parts.some((part) => !part || FORBIDDEN.includes(part))) return undefined;
  let current: unknown = scene;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    if (current === null || current === undefined) return undefined;
    if (COLLECTIONS.includes(key)) {
      const list = (current as Record<string, unknown>)[key];
      if (!Array.isArray(list)) return undefined;
      if(i+1>=parts.length)return list;
      const id = parts[++i];
      current = list.find((item) => item && typeof item === 'object'
        && ((item as Record<string, unknown>).id === id || (item as Record<string, unknown>).name === id));
    } else if (Array.isArray(current)) {
      return undefined;
    } else if (typeof current === 'object' && Object.hasOwn(current,key)) {
      current = (current as Record<string, unknown>)[key];
    } else return undefined;
  }
  return current;
}

function validDraftPath(scene: Record<string, unknown>, path: string): boolean {
  if (resolveField(scene, path) !== undefined) return true;
  const parts = path.split('.');
  return parts.length === 2 && parts[0] === 'asks' && ASK_KINDS.includes(parts[1]);
}

// Models sometimes prefix paths with the root name ("scene.bodies.A.mass");
// the alias is unambiguous, so normalize it instead of rejecting the draft.
function normalizeScenePath(path: string): string {
  return path.startsWith('scene.') ? path.slice('scene.'.length) : path;
}

export function validateScene(value: unknown): Record<string, unknown> {
  const v = asObject(value, 'scene');
  keys(v,['version','rev','title','gravity','dimension','bodies','supports','contacts','asks','params','bindings','fields','links','fieldPlayback','collision'],'scene');
  if (v.version !== 2) fail('scene.version 必须为 2');
  if(v.dimension!==undefined&&!['2d','3d'].includes(v.dimension as string))fail('scene.dimension 必须为 2d 或 3d');

  const bodies = asArray(v.bodies, 'scene.bodies').map((item, index) => {
    const path = `bodies.${index}`;
    const row = asObject(item, path);
    // 附着物体的位置可由支撑面起点 + 弧长 s 导出；模型常写 pos:null。
    if ((row.pos === null || row.pos === undefined) && row.attach && typeof row.attach === 'object') {
      const att = row.attach as Record<string, unknown>;
      const sup = (Array.isArray(v.supports) ? v.supports : []).find((x: any) => x && x.id === att.support);
      if (sup && sup.a && typeof sup.a.x === 'number' && typeof sup.a.y === 'number') {
        const th = (typeof sup.angleDeg === 'number' ? sup.angleDeg : 0) * Math.PI / 180;
        const s = typeof att.s === 'number' ? att.s : 0;
        row.pos = { x: sup.a.x + s * Math.cos(th), y: sup.a.y + s * Math.sin(th) };
      }
    }
    // 附着物体静止释放时模型常写 vel:null 或 {x:null,y:null}；沿面初速缺省为 0。
    const velMissing = row.vel === null || row.vel === undefined
      || (typeof row.vel === 'object' && ((row.vel as Record<string, unknown>).x === null || (row.vel as Record<string, unknown>).x === undefined));
    if (velMissing && row.attach && typeof row.attach === 'object') {
      row.vel = { x: 0, y: 0 };
    }
    keys(row,['id','kind','name','attach','pos','vel','mass','accel','charge','charged','collisionRadius','flow','width','radius','omega','phase'],path);
    if (!['block','ball','projectile','boat','circular'].includes(row.kind as string)) fail(`${path}.kind 不是支持的物体类型`);
    if (row.attach !== null) {
      const attach = asObject(row.attach, `${path}.attach`);
      asString(attach.support, `${path}.attach.support`);
      asNullableFinite(attach.s, `${path}.attach.s`);
    }
    const pos = asObject(row.pos, `${path}.pos`);
    const vel = asObject(row.vel, `${path}.vel`);
    asString(row.id, `${path}.id`);
    asString(row.name, `${path}.name`);
    asNullableFinite(pos.x, `${path}.pos.x`);
    asNullableFinite(pos.y, `${path}.pos.y`);
    asNullableFinite(vel.x, `${path}.vel.x`);
    asNullableFinite(vel.y, `${path}.vel.y`);
    asNullableFinite(row.mass, `${path}.mass`);
    asNullableFinite(row.accel, `${path}.accel`);
    vector(pos,path+'.pos',true,true);vector(vel,path+'.vel',true,true);
    for(const key of ['charge','collisionRadius','width','radius','omega','phase'])if(row[key]!==undefined)asNullableFinite(row[key],path+'.'+key);
    if(row.collisionRadius!==undefined&&row.collisionRadius!==null&&(row.collisionRadius as number)<=0)fail(path+'.collisionRadius 必须为正');
    if(row.charged!==undefined&&typeof row.charged!=='boolean')fail(path+'.charged 必须是布尔值');
    if(row.flow!==undefined&&row.flow!==null)vector(row.flow,path+'.flow',true);
    return row;
  });

  const supports = asArray(v.supports, 'scene.supports').map((item, index) => {
    const path = `supports.${index}`;
    const row = asObject(item, path);
    if (row.kind !== 'horizontal' && row.kind !== 'incline') fail(`${path}.kind 不是支持的支撑面类型`);
    asString(row.id, `${path}.id`);
    asString(row.name, `${path}.name`);
    const a = asObject(row.a, `${path}.a`);
    asFinite(a.x, `${path}.a.x`);
    asFinite(a.y, `${path}.a.y`);
    asNullableFinite(row.length, `${path}.length`);
    asNullableFinite(row.angleDeg, `${path}.angleDeg`);
    return row;
  });

  const contacts = asArray(v.contacts, 'scene.contacts').map((item, index) => {
    const path = `contacts.${index}`;
    const row = asObject(item, path);
    asString(row.id, `${path}.id`);
    asString(row.body, `${path}.body`);
    asString(row.support, `${path}.support`);
    asNullableFinite(row.mu_s, `${path}.mu_s`);
    asNullableFinite(row.mu_k, `${path}.mu_k`);
    return row;
  });

  const asks = asArray(v.asks, 'scene.asks').map((item, index) => {
    const path = `asks.${index}`;
    const row = asObject(item, path);
    if (typeof row.kind !== 'string' || !ASK_KINDS.includes(row.kind)) fail(`${path}.kind 不是支持的求解目标`);
    asString(row.id, `${path}.id`);
    asNullableFinite(row.t, `${path}.t`);
    asNullableFinite(row.x, `${path}.x`);
    asNullableFinite(row.y, `${path}.y`);
    asNullableFinite(row.v, `${path}.v`);
    keys(row,['id','kind','t','x','y','v','fieldId','energyFrom','energyTo','question'],path);
    if(row.fieldId!==undefined&&row.fieldId!==null)asString(row.fieldId,path+'.fieldId');
    for(const key of ['energyFrom','energyTo'])if(row[key]!==undefined&&row[key]!==null)energyPoint(row[key],path+'.'+key);
    if(row.question!==undefined)asString(row.question,path+'.question');
    if(row.kind==='custom'&&!(typeof row.question==='string'&&row.question.trim()))fail(path+'.question 需要保留原待求问题');
    return row;
  });

  const params = asArray(v.params, 'scene.params').map((item, index) => {
    const path = `params.${index}`;
    const row = asObject(item, path);
    if (typeof row.unit !== 'string' || !UNIT_KINDS.includes(row.unit)) fail(`${path}.unit 不是支持的单位类型`);
    const min = asFinite(row.min, `${path}.min`);
    const max = asFinite(row.max, `${path}.max`);
    const step = asFinite(row.step, `${path}.step`);
    if (min > max || step <= 0) fail(`${path} 的范围或步长无效`);
    asString(row.name, `${path}.name`);
    asNullableFinite(row.value, `${path}.value`);
    if (row.note !== undefined) asString(row.note, `${path}.note`);
    return row;
  });

  uniqueIds(bodies, 'scene.bodies');
  uniqueIds(supports, 'scene.supports');
  uniqueIds(contacts, 'scene.contacts');
  uniqueIds(asks, 'scene.asks');
  const paramNames = new Set<string>();
  params.forEach((row) => {
    const name = row.name as string;
    if (paramNames.has(name)) fail(`params 包含重复名称：${name}`);
    paramNames.add(name);
  });

  const rev = asFinite(v.rev, 'scene.rev');
  if (!Number.isInteger(rev) || rev < 0) fail('scene.rev 必须是非负整数');
  asString(v.title, 'scene.title');
  asNullableFinite(v.gravity, 'scene.gravity');

  const supportIds = new Set(supports.map((row) => row.id as string));
  const bodyIds = new Set(bodies.map((row) => row.id as string));
  const fields=v.fields===undefined?[]:asArray(v.fields,'scene.fields').map((item,index)=>{
    const path=`fields.${index}`,f=asObject(item,path);
    keys(f,['id','name','kind','enabled','shape','position','vector','plates','gradient','bx','by','bz','sourceStrength','cutoffRadius'],path);
    asString(f.id,path+'.id');asString(f.name,path+'.name');
    if(!['uniform_gravity','uniform_electric','uniform_magnetic','point_mass','point_charge'].includes(f.kind as string))fail(path+'.kind 无效');
    if(typeof f.enabled!=='boolean')fail(path+'.enabled 必须是布尔值');
    // 全局场无需位置；磁场面内矢量可为 null（由 bz 表达）。其余场矢量保持严格，
    // 避免把缺失场强静默归零。
    if(f.position===undefined||f.position===null)f.position={x:0,y:0};
    if(f.kind==='uniform_magnetic'&&(f.vector===undefined||f.vector===null))f.vector={x:0,y:0};
    if(f.shape===undefined||f.shape===null)f.shape={kind:'global'};
    vector(f.position,path+'.position',false,true);vector(f.vector,path+'.vector',true,true);
    for(const key of ['bz','bx','by','sourceStrength','cutoffRadius'])if(f[key]!==undefined)asNullableFinite(f[key],path+'.'+key);
    const shape=asObject(f.shape,path+'.shape');
    if(shape.kind==='global')keys(shape,['kind'],path+'.shape');
    else if(shape.kind==='rect'){keys(shape,['kind','center','width','height'],path+'.shape');vector(shape.center,path+'.shape.center');asFinite(shape.width,path+'.shape.width');asFinite(shape.height,path+'.shape.height');}
    else if(shape.kind==='circle'){keys(shape,['kind','center','radius'],path+'.shape');vector(shape.center,path+'.shape.center');asFinite(shape.radius,path+'.shape.radius');}
    else if(shape.kind==='polygon'){keys(shape,['kind','vertices'],path+'.shape');asArray(shape.vertices,path+'.shape.vertices').forEach((p,i)=>vector(p,path+'.shape.vertices.'+i));}
    else fail(path+'.shape.kind 无效');
    if(f.gradient!==undefined&&f.gradient!==null)vector(f.gradient,path+'.gradient',true,true);
    if(f.plates!==undefined&&f.plates!==null){const p=asObject(f.plates,path+'.plates');keys(p,['axis','voltage'],path+'.plates');if(!['x','y'].includes(p.axis as string))fail(path+'.plates.axis 无效');asNullableFinite(p.voltage,path+'.plates.voltage');}
    return f;
  });
  const links=v.links===undefined?[]:asArray(v.links,'scene.links').map((item,index)=>{
    const path=`links.${index}`,l=asObject(item,path);keys(l,['id','name','kind','anchor','bodyId','length'],path);
    asString(l.id,path+'.id');asString(l.name,path+'.name');if(!['rope','rod'].includes(l.kind as string))fail(path+'.kind 无效');
    vector(l.anchor,path+'.anchor');asFinite(l.length,path+'.length');
    if(l.bodyId!==null&&!bodyIds.has(asString(l.bodyId,path+'.bodyId')))fail(path+'.bodyId 引用不存在');
    return l;
  });
  uniqueIds(fields,'scene.fields');uniqueIds(links,'scene.links');uniqueIds([...bodies,...supports,...fields,...links],'scene.objects');
  const fieldIds=new Set(fields.map(f=>f.id));
  for(const ask of asks)if(ask.fieldId!==undefined&&ask.fieldId!==null&&!fieldIds.has(ask.fieldId))fail('asks.'+ask.id+'.fieldId 引用不存在');
  if(v.fieldPlayback!==undefined&&v.fieldPlayback!==null){
    const p=asObject(v.fieldPlayback,'scene.fieldPlayback');keys(p,['duration','exit','fieldId','afterExit'],'scene.fieldPlayback');
    asFinite(p.duration,'fieldPlayback.duration');asFinite(p.afterExit,'fieldPlayback.afterExit');
    if(!['continue','field','union'].includes(p.exit as string))fail('fieldPlayback.exit 无效');
    if(p.fieldId!==null&&!fieldIds.has(asString(p.fieldId,'fieldPlayback.fieldId')))fail('fieldPlayback.fieldId 引用不存在');
  }
  if(v.collision!==undefined&&v.collision!==null){const c=asObject(v.collision,'scene.collision');keys(c,['restitution','afterCollision'],'scene.collision');asNullableFinite(c.restitution,'collision.restitution');asNullableFinite(c.afterCollision,'collision.afterCollision');}
  bodies.forEach((row) => {
    if (row.attach === null) return;
    const support = (row.attach as Record<string, unknown>).support as string;
    if (!supportIds.has(support)) fail(`bodies.${row.id}.attach.support 引用不存在`);
  });
  contacts.forEach((row) => {
    if (!bodyIds.has(row.body as string) || !supportIds.has(row.support as string)) {
      fail(`contacts.${row.id} 引用不存在的物体或支撑面`);
    }
  });

  if(v.bindings===null)v.bindings={};
  const bindings = asObject(v.bindings, 'scene.bindings');
  const normalizedBindings: Record<string, unknown> = {};
  for (const [rawPath, paramNameValue] of Object.entries(bindings)) {
    const path = normalizeScenePath(rawPath);
    if (Object.hasOwn(normalizedBindings, path)) fail(`scene.bindings.${path} 归一化后路径重复`);
    const paramName = asString(paramNameValue, `scene.bindings.${rawPath}`);
    if (!paramNames.has(paramName)) fail(`scene.bindings.${path} 引用不存在的参数`);
    const target = resolveField(v, path);
    if (target === undefined || (target !== null && typeof target !== 'number')) fail(`scene.bindings.${path} 不是可绑定的数值字段`);
    normalizedBindings[path] = paramName;
  }
  v.bindings = normalizedBindings;
  return v;
}

/** Drop bindings that cannot resolve (unknown param/path/non-numeric/duplicate).
 * Bindings are slider conveniences, not physics conditions; dropping them with an
 * explicit warning keeps otherwise usable drafts applicable. */
function pruneBindings(sceneValue: unknown): string[] {
  if (sceneValue === null || typeof sceneValue !== 'object' || Array.isArray(sceneValue)) return [];
  const sc = sceneValue as Record<string, unknown>;
  if (sc.bindings === null) sc.bindings = {};
  if (sc.bindings === undefined || typeof sc.bindings !== 'object' || Array.isArray(sc.bindings)) return [];
  const params = new Set((Array.isArray(sc.params) ? sc.params : [])
    .map((p: any) => p?.name).filter((n: unknown) => typeof n === 'string'));
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const [rawPath, val] of Object.entries(sc.bindings as Record<string, unknown>)) {
    let ok = false;
    try {
      const path = normalizeScenePath(rawPath);
      const target = resolveField(sc, path);
      ok = typeof val === 'string' && params.has(val) && !seen.has(path)
        && target !== undefined && (target === null || typeof target === 'number');
      if (ok) seen.add(path);
    } catch {
      ok = false;
    }
    if (!ok) {
      delete (sc.bindings as Record<string, unknown>)[rawPath];
      dropped.push(rawPath);
    }
  }
  return dropped;
}

/** 平行板模式缺电压时退化为普通匀强场（vector 已给场强），避免求解器拒绝。 */
function prunePlates(sceneValue: unknown): string[] {
  if (sceneValue === null || typeof sceneValue !== 'object' || Array.isArray(sceneValue)) return [];
  const sc = sceneValue as Record<string, unknown>;
  const dropped: string[] = [];
  for (const f of Array.isArray(sc.fields) ? sc.fields : []) {
    if (f && typeof f === 'object' && (f as Record<string, unknown>).plates && typeof (f as Record<string, unknown>).plates === 'object') {
      const plates = (f as Record<string, unknown>).plates as Record<string, unknown>;
      if (plates.voltage === null || plates.voltage === undefined) {
        delete (f as Record<string, unknown>).plates;
        dropped.push(String((f as Record<string, unknown>).id ?? ''));
      }
    }
  }
  return dropped;
}

/** Returns the validated draft so the caller can forward exactly what was checked. */
export function validateSceneDraft(value: unknown): Record<string, unknown> {
  const v = asObject(value, 'draft');
  const source = asObject(v.source, 'draft.source');
  if (source.rawText !== undefined) asString(source.rawText, 'draft.source.rawText');
  if (source.imageName !== undefined) asString(source.imageName, 'draft.source.imageName');
  if (source.demo !== undefined && typeof source.demo !== 'boolean') fail('draft.source.demo 必须是布尔值');

  const dropped = [
    ...pruneBindings(v.scene),
    ...(Array.isArray(v.stages) ? v.stages.flatMap((s: any) => pruneBindings(s?.scene)) : []),
  ];
  const droppedPlates = [
    ...prunePlates(v.scene),
    ...(Array.isArray(v.stages) ? v.stages.flatMap((s: any) => prunePlates(s?.scene)) : []),
  ];
  if (droppedPlates.length) {
    const warnings = Array.isArray(v.warnings) ? v.warnings : (v.warnings = []);
    warnings.push(`平行板模式缺电压，已按给定场强矢量建模（${droppedPlates.join('、')}）。`);
  }
  // 支撑面题型（斜面等）用 scene.gravity 数值；模型常写全局重力场代替，迁移之。
  const migrateGravity = (sceneValue: unknown): boolean => {
    if (sceneValue === null || typeof sceneValue !== 'object' || Array.isArray(sceneValue)) return false;
    const sc = sceneValue as Record<string, unknown>;
    if (sc.gravity !== null && sc.gravity !== undefined) return false;
    if (!Array.isArray(sc.supports) || !sc.supports.length) return false;
    const fields = Array.isArray(sc.fields) ? sc.fields : [];
    const g = fields.find((f: any) => f && f.kind === 'uniform_gravity' && f.shape && f.shape.kind === 'global' && f.vector && typeof f.vector.y === 'number');
    if (!g) return false;
    sc.gravity = -(g as any).vector.y;
    sc.fields = fields.filter((f: any) => f !== g);
    return true;
  };
  const migrated = [migrateGravity(v.scene), ...(Array.isArray(v.stages) ? v.stages.map((s: any) => migrateGravity(s?.scene)) : [])].filter(Boolean).length;
  if (migrated) {
    const warnings = Array.isArray(v.warnings) ? v.warnings : (v.warnings = []);
    warnings.push('全局重力场已迁移为场景重力加速度数值（支撑面题型口径）。');
  }
  // 题面只给静摩擦因数时模型常留 mu_k:null；滑动求解需要 mu_k，取 mu_s 近似并明示。
  const fillMuK = (sceneValue: unknown): number => {
    if (sceneValue === null || typeof sceneValue !== 'object' || Array.isArray(sceneValue)) return 0;
    const sc = sceneValue as Record<string, unknown>;
    let n = 0;
    for (const c of Array.isArray(sc.contacts) ? sc.contacts : []) {
      if (c && typeof c === 'object') {
        const row = c as Record<string, unknown>;
        if ((row.mu_k === null || row.mu_k === undefined) && typeof row.mu_s === 'number') {
          row.mu_k = row.mu_s;
          n += 1;
        }
      }
    }
    return n;
  };
  const muFilled = [fillMuK(v.scene), ...(Array.isArray(v.stages) ? v.stages.map((s: any) => fillMuK(s?.scene)) : [])].reduce((a, b) => a + b, 0);
  if (muFilled) {
    const warnings = Array.isArray(v.warnings) ? v.warnings : (v.warnings = []);
    warnings.push(`题面未给动摩擦因数，已按 mu_k=mu_s 近似（${muFilled} 处），请核对。`);
  }
  if (dropped.length) {
    const warnings = Array.isArray(v.warnings) ? v.warnings : (v.warnings = []);
    warnings.push(`已忽略 ${dropped.length} 条无效参数绑定（${dropped.slice(0, 3).join('、')}${dropped.length > 3 ? ' 等' : ''}），物理条件与数值不受影响。`);
  }

  const scene = validateScene(v.scene);
  // Models often keep the collision in the primary scene and reference it as
  // 'main'; materialize it as stages[0] so velocityFrom injection stays uniform.
  if (Array.isArray(v.stages) && !v.stages.some((s: any) => s?.id === 'main')
    && v.stages.some((s: any) => s?.velocityFrom?.stageId === 'main')) {
    v.stages = [{ id: 'main', title: (v.scene as Record<string, unknown>).title ?? '主阶段', scene: v.scene }, ...v.stages];
  }
  const stages=v.stages===undefined||v.stages===null?[]:asArray(v.stages,'draft.stages').map((item,index)=>{
    const path='draft.stages.'+index,s=asObject(item,path);keys(s,['id','title','scene','velocityFrom'],path);
    asString(s.id,path+'.id');asString(s.title,path+'.title');validateScene(s.scene);return s;
  });
  uniqueIds(stages,'draft.stages');
  stages.forEach((s,index)=>{
    if(s.velocityFrom===undefined||s.velocityFrom===null)return;
    const dep=asObject(s.velocityFrom,'draft.stages.'+index+'.velocityFrom');keys(dep,['stageId','sourceBodyId','targetBodyId'],'stage.velocityFrom');
    for(const key of ['stageId','sourceBodyId','targetBodyId'])asString(dep[key],'stage.velocityFrom.'+key);
    const prior=stages.slice(0,index).find(p=>p.id===dep.stageId);
    if(!prior)fail('stage.velocityFrom.stageId 必须引用较早的阶段');
    const source=prior.scene as Record<string,unknown>,target=s.scene as Record<string,unknown>;
    if(!Array.isArray(source.bodies)||!source.bodies.some(b=>b.id===dep.sourceBodyId)||!Array.isArray(target.bodies)||!target.bodies.some(b=>b.id===dep.targetBodyId))fail('stage.velocityFrom 物体引用不存在');
  });
  const validPath=(path:string)=>path.startsWith('stages.')?resolveField(v,path)!==undefined:validDraftPath(scene,path);
  // Models sometimes write stage-local paths without the stages prefix; resolve
  // them against each stage and rewrite so UI jumps stay correct.
  const fixPath=(p:string)=>{
    if(p.startsWith('stages.')||validDraftPath(scene,p))return p;
    for(const s of stages){if(resolveField(s.scene as Record<string, unknown>,p)!==undefined)return `stages.${s.id}.scene.${p}`;}
    return p;
  };
  const knownAll = asArray(v.known, 'draft.known').map((item, index) => {
    const path = `draft.known.${index}`;
    const row = asObject(item, path);
    row.path = fixPath(normalizeScenePath(asString(row.path, `${path}.path`)));
    asString(row.label, `${path}.label`);
    asString(row.value, `${path}.value`);
    if (row.quote !== undefined && row.quote !== null) asString(row.quote, `${path}.quote`);
    if (row.basis !== undefined && row.basis !== null) asString(row.basis, `${path}.basis`);
    return row;
  });
  const assumedAll = asArray(v.assumed, 'draft.assumed').map((item, index) => {
    const path = `draft.assumed.${index}`;
    const row = asObject(item, path);
    row.path = fixPath(normalizeScenePath(asString(row.path, `${path}.path`)));
    asString(row.label, `${path}.label`);
    asString(row.value, `${path}.value`);
    if (row.quote !== undefined && row.quote !== null) asString(row.quote, `${path}.quote`);
    if (row.basis !== undefined && row.basis !== null) asString(row.basis, `${path}.basis`);
    return row;
  });
  // 已知/假设行是展示性溯源 metadata；路径无法定位时剔除并明示，物理量以 scene 为准。
  const keepRow = (row: Record<string, unknown>, kind: string) => {
    if (validPath(row.path as string)) return true;
    const warnings = Array.isArray(v.warnings) ? v.warnings : (v.warnings = []);
    warnings.push(`已忽略无法定位的${kind}条目：${row.path}（${row.label ?? ''} ${row.quote ?? ''}）。`);
    return false;
  };
  const known = knownAll.filter((row) => keepRow(row, '已知'));
  const assumed = assumedAll.filter((row) => keepRow(row, '假设'));
  v.known = known;
  v.assumed = assumed;
  const unknownAll = asArray(v.unknown, 'draft.unknown').map((item, index) => {
    const path = `draft.unknown.${index}`;
    const row = asObject(item, path);
    row.path = fixPath(normalizeScenePath(asString(row.path, `${path}.path`)));
    asString(row.label, `${path}.label`);
    return row;
  });
  // 模型常把派生量（碰后速度、半径、周期、落点等）写成不存在的场景路径；
  // 待求问题已由 asks 逐字保留，这些冗余标记剔除并明示，不丢题面条件。
  const unknown = unknownAll.filter((row) => {
    if (validPath(row.path as string)) return true;
    const warnings = Array.isArray(v.warnings) ? v.warnings : (v.warnings = []);
    warnings.push(`已忽略无法定位的待求标记：${row.path}（待求问题以 asks 为准）。`);
    return false;
  });
  v.unknown = unknown;
  const uncertain: string[] = [];
  for (const [index, item] of asArray(v.uncertain, 'draft.uncertain').entries()) {
    const entry = asString(item, `draft.uncertain.${index}`);
    let path = entry;
    try { path = normalizeScenePath(entry); } catch { path = entry; }
    path = fixPath(path);
    if (validPath(path)) { uncertain.push(path); continue; }
    // Prose uncertainty notes are preserved as warnings instead of rejecting the draft.
    const warnings = Array.isArray(v.warnings) ? v.warnings : (v.warnings = []);
    warnings.push(`模型不确定性说明（非路径，已转入警告）：${entry}`);
  }
  v.uncertain = uncertain;
  asArray(v.warnings, 'draft.warnings').forEach((item, index) => asString(item, `draft.warnings.${index}`));

  [...known, ...assumed, ...unknown].forEach((row) => {
    if (!validPath(row.path as string)) fail(`draft 路径不存在：${row.path}`);
  });
  uncertain.forEach((path) => {
    if (!validPath(path)) fail(`draft.uncertain 路径不存在：${path}`);
  });
  return v;
}
