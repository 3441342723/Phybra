// Server-side mirror of src/model/runtime.ts. The Function package is self-contained
// and cannot import the browser bundle, so the contract is duplicated here deliberately.

export class DraftContractError extends Error {}

const UNIT_KINDS = ['length', 'time', 'speed', 'accel', 'mass', 'angle', 'none'];
const ASK_KINDS = ['at_time', 'at_height', 'at_position', 'at_velocity', 'landing', 'apex', 'rest', 'end_of_support', 'friction_state'];
const COLLECTIONS = ['bodies', 'supports', 'contacts', 'asks', 'params'];

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
  if (parts.length < 1 || parts[0] === 'bindings' || parts.some((part) => !part)) return undefined;
  let current: unknown = scene;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    if (current === null || current === undefined) return undefined;
    if (COLLECTIONS.includes(key)) {
      const list = (current as Record<string, unknown>)[key];
      if (!Array.isArray(list) || i + 1 >= parts.length) return undefined;
      const id = parts[++i];
      current = list.find((item) => item && typeof item === 'object'
        && ((item as Record<string, unknown>).id === id || (item as Record<string, unknown>).name === id));
    } else if (Array.isArray(current)) {
      return undefined;
    } else if (typeof current === 'object') {
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

function validateScene(value: unknown): Record<string, unknown> {
  const v = asObject(value, 'scene');
  if (v.version !== 2) fail('scene.version 必须为 2');

  const bodies = asArray(v.bodies, 'scene.bodies').map((item, index) => {
    const path = `bodies.${index}`;
    const row = asObject(item, path);
    if (row.kind !== 'block' && row.kind !== 'projectile') fail(`${path}.kind 不是支持的物体类型`);
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

  const bindings = asObject(v.bindings, 'scene.bindings');
  for (const [path, paramNameValue] of Object.entries(bindings)) {
    const paramName = asString(paramNameValue, `scene.bindings.${path}`);
    if (!paramNames.has(paramName)) fail(`scene.bindings.${path} 引用不存在的参数`);
    const target = resolveField(v, path);
    if (target === undefined || (target !== null && typeof target !== 'number')) fail(`scene.bindings.${path} 不是可绑定的数值字段`);
  }
  return v;
}

/** Returns the validated draft so the caller can forward exactly what was checked. */
export function validateSceneDraft(value: unknown): Record<string, unknown> {
  const v = asObject(value, 'draft');
  const source = asObject(v.source, 'draft.source');
  if (source.rawText !== undefined) asString(source.rawText, 'draft.source.rawText');
  if (source.imageName !== undefined) asString(source.imageName, 'draft.source.imageName');
  if (source.demo !== undefined && typeof source.demo !== 'boolean') fail('draft.source.demo 必须是布尔值');

  const scene = validateScene(v.scene);
  const known = asArray(v.known, 'draft.known').map((item, index) => {
    const path = `draft.known.${index}`;
    const row = asObject(item, path);
    asString(row.path, `${path}.path`);
    asString(row.label, `${path}.label`);
    asString(row.value, `${path}.value`);
    if (row.quote !== undefined) asString(row.quote, `${path}.quote`);
    if (row.basis !== undefined) asString(row.basis, `${path}.basis`);
    return row;
  });
  const assumed = asArray(v.assumed, 'draft.assumed').map((item, index) => {
    const path = `draft.assumed.${index}`;
    const row = asObject(item, path);
    asString(row.path, `${path}.path`);
    asString(row.label, `${path}.label`);
    asString(row.value, `${path}.value`);
    if (row.quote !== undefined) asString(row.quote, `${path}.quote`);
    if (row.basis !== undefined) asString(row.basis, `${path}.basis`);
    return row;
  });
  const unknown = asArray(v.unknown, 'draft.unknown').map((item, index) => {
    const path = `draft.unknown.${index}`;
    const row = asObject(item, path);
    asString(row.path, `${path}.path`);
    asString(row.label, `${path}.label`);
    return row;
  });
  const uncertain = asArray(v.uncertain, 'draft.uncertain').map((item, index) => asString(item, `draft.uncertain.${index}`));
  asArray(v.warnings, 'draft.warnings').forEach((item, index) => asString(item, `draft.warnings.${index}`));

  [...known, ...assumed, ...unknown].forEach((row) => {
    if (!validDraftPath(scene, row.path as string)) fail(`draft 路径不存在：${row.path}`);
  });
  uncertain.forEach((path) => {
    if (!validDraftPath(scene, path)) fail(`draft.uncertain 路径不存在：${path}`);
  });
  return v;
}
