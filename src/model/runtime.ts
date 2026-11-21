import type { AskKind, Body, Contact, Scene, SceneDraft, Support, UnitKind } from './types';

const UNIT_KINDS: readonly UnitKind[] = ['length', 'time', 'speed', 'accel', 'mass', 'angle', 'none'];
const ASK_KINDS: readonly AskKind[] = ['at_time', 'at_height', 'at_position', 'at_velocity', 'landing', 'apex', 'rest', 'end_of_support', 'friction_state'];
const COLLECTIONS = new Set(['bodies', 'supports', 'contacts', 'asks', 'params']);

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} 必须是字符串`);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} 必须是有限数字`);
  return value;
}

function nullableFinite(value: unknown, path: string): number | null {
  return value === null ? null : finite(value, path);
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  return value;
}

function uniqueIds(items: Array<Record<string, unknown>>, path: string): void {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    const id = string(item.id, `${path}.${index}.id`);
    if (ids.has(id)) throw new Error(`${path} 包含重复 id：${id}`);
    ids.add(id);
  });
}

function vec2(value: unknown, path: string): { x: number; y: number } {
  const v = object(value, path);
  return { x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`) };
}

function parseBody(value: unknown, index: number): Body {
  const path = `bodies.${index}`;
  const v = object(value, path);
  const kind = string(v.kind, `${path}.kind`);
  if (kind !== 'block' && kind !== 'projectile') throw new Error(`${path}.kind 不是支持的物体类型`);
  let attach: Body['attach'] = null;
  if (v.attach !== null) {
    const a = object(v.attach, `${path}.attach`);
    attach = { support: string(a.support, `${path}.attach.support`), s: nullableFinite(a.s, `${path}.attach.s`) };
  }
  const pos = object(v.pos, `${path}.pos`);
  const vel = object(v.vel, `${path}.vel`);
  return {
    id: string(v.id, `${path}.id`), kind, name: string(v.name, `${path}.name`), attach,
    pos: { x: nullableFinite(pos.x, `${path}.pos.x`), y: nullableFinite(pos.y, `${path}.pos.y`) },
    vel: { x: nullableFinite(vel.x, `${path}.vel.x`), y: nullableFinite(vel.y, `${path}.vel.y`) },
    mass: nullableFinite(v.mass, `${path}.mass`), accel: nullableFinite(v.accel, `${path}.accel`),
  };
}

function parseSupport(value: unknown, index: number): Support {
  const path = `supports.${index}`;
  const v = object(value, path);
  const kind = string(v.kind, `${path}.kind`);
  if (kind !== 'horizontal' && kind !== 'incline') throw new Error(`${path}.kind 不是支持的支撑面类型`);
  return {
    id: string(v.id, `${path}.id`), name: string(v.name, `${path}.name`), kind,
    a: vec2(v.a, `${path}.a`), length: nullableFinite(v.length, `${path}.length`), angleDeg: nullableFinite(v.angleDeg, `${path}.angleDeg`),
  };
}

function parseContact(value: unknown, index: number): Contact {
  const path = `contacts.${index}`;
  const v = object(value, path);
  return { id: string(v.id, `${path}.id`), body: string(v.body, `${path}.body`), support: string(v.support, `${path}.support`), mu_s: nullableFinite(v.mu_s, `${path}.mu_s`), mu_k: nullableFinite(v.mu_k, `${path}.mu_k`) };
}

function parseAsk(value: unknown, index: number) {
  const path = `asks.${index}`;
  const v = object(value, path);
  const kind = string(v.kind, `${path}.kind`);
  if (!ASK_KINDS.includes(kind as AskKind)) throw new Error(`${path}.kind 不是支持的求解目标`);
  return { id: string(v.id, `${path}.id`), kind: kind as AskKind, t: nullableFinite(v.t, `${path}.t`), x: nullableFinite(v.x, `${path}.x`), y: nullableFinite(v.y, `${path}.y`), v: nullableFinite(v.v, `${path}.v`) };
}

function parseParam(value: unknown, index: number) {
  const path = `params.${index}`;
  const v = object(value, path);
  const unit = string(v.unit, `${path}.unit`);
  if (!UNIT_KINDS.includes(unit as UnitKind)) throw new Error(`${path}.unit 不是支持的单位类型`);
  const min = finite(v.min, `${path}.min`);
  const max = finite(v.max, `${path}.max`);
  const step = finite(v.step, `${path}.step`);
  if (min > max || step <= 0) throw new Error(`${path} 的范围或步长无效`);
  return { name: string(v.name, `${path}.name`), value: nullableFinite(v.value, `${path}.value`), unit: unit as UnitKind, min, max, step, ...(v.note === undefined ? {} : { note: string(v.note, `${path}.note`) }) };
}

function resolvePath(scene: Scene, path: string): unknown {
  const parts = path.split('.');
  if (parts.length < 1 || parts[0] === 'bindings' || parts.some((part) => !part)) return undefined;
  let current: unknown = scene;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    if (current === null || current === undefined) return undefined;
    if (COLLECTIONS.has(key)) {
      const list = (current as Record<string, unknown>)[key];
      if (!Array.isArray(list) || i + 1 >= parts.length) return undefined;
      const id = parts[++i];
      current = list.find((item) => item && typeof item === 'object' && ((item as Record<string, unknown>).id === id || (item as Record<string, unknown>).name === id));
    } else if (Array.isArray(current)) {
      return undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
    } else return undefined;
  }
  return current;
}

function validDraftPath(scene: Scene, path: string): boolean {
  if (resolvePath(scene, path) !== undefined) return true;
  const parts = path.split('.');
  return parts.length === 2 && parts[0] === 'asks' && ASK_KINDS.includes(parts[1] as AskKind);
}

export function parseScene(value: unknown): Scene {
  const v = object(value, 'scene');
  if (v.version !== 2) throw new Error('scene.version 必须为 2');
  const bodyValues = array(v.bodies, 'scene.bodies').map(parseBody);
  const supportValues = array(v.supports, 'scene.supports').map(parseSupport);
  const contactValues = array(v.contacts, 'scene.contacts').map(parseContact);
  const askValues = array(v.asks, 'scene.asks').map(parseAsk);
  const paramValues = array(v.params, 'scene.params').map(parseParam);
  uniqueIds(bodyValues as unknown as Array<Record<string, unknown>>, 'scene.bodies');
  uniqueIds(supportValues as unknown as Array<Record<string, unknown>>, 'scene.supports');
  uniqueIds(contactValues as unknown as Array<Record<string, unknown>>, 'scene.contacts');
  uniqueIds(askValues as unknown as Array<Record<string, unknown>>, 'scene.asks');
  const paramNames = new Set<string>();
  paramValues.forEach((param) => { if (paramNames.has(param.name)) throw new Error(`params 包含重复名称：${param.name}`); paramNames.add(param.name); });
  const scene: Scene = {
    version: 2, rev: finite(v.rev, 'scene.rev'), title: string(v.title, 'scene.title'), gravity: nullableFinite(v.gravity, 'scene.gravity'),
    bodies: bodyValues, supports: supportValues, contacts: contactValues, asks: askValues, params: paramValues,
    bindings: {},
  };
  if (!Number.isInteger(scene.rev) || scene.rev < 0) throw new Error('scene.rev 必须是非负整数');
  const bodyIds = new Set(scene.bodies.map((item) => item.id));
  const supportIds = new Set(scene.supports.map((item) => item.id));
  scene.bodies.forEach((body) => { if (body.attach && !supportIds.has(body.attach.support)) throw new Error(`bodies.${body.id}.attach.support 引用不存在`); });
  scene.contacts.forEach((contact) => { if (!bodyIds.has(contact.body) || !supportIds.has(contact.support)) throw new Error(`contacts.${contact.id} 引用不存在的物体或支撑面`); });
  const bindings = object(v.bindings, 'scene.bindings');
  for (const [path, paramNameValue] of Object.entries(bindings)) {
    const paramName = string(paramNameValue, `scene.bindings.${path}`);
    if (!paramNames.has(paramName)) throw new Error(`scene.bindings.${path} 引用不存在的参数`);
    const target = resolvePath(scene, path);
    if (target === undefined || (target !== null && typeof target !== 'number')) throw new Error(`scene.bindings.${path} 不是可绑定的数值字段`);
    scene.bindings[path] = paramName;
  }
  return scene;
}

function draftItem(value: unknown, path: string): { path: string; label: string; value: string; quote?: string; basis?: string } {
  const v = object(value, path);
  const result: { path: string; label: string; value: string; quote?: string; basis?: string } = { path: string(v.path, `${path}.path`), label: string(v.label, `${path}.label`), value: string(v.value, `${path}.value`) };
  if (v.quote !== undefined) result.quote = string(v.quote, `${path}.quote`);
  if (v.basis !== undefined) result.basis = string(v.basis, `${path}.basis`);
  return result;
}

export function parseSceneDraft(value: unknown): SceneDraft {
  const v = object(value, 'draft');
  const sourceValue = object(v.source, 'draft.source');
  const source: SceneDraft['source'] = {};
  if (sourceValue.rawText !== undefined) source.rawText = string(sourceValue.rawText, 'draft.source.rawText');
  if (sourceValue.imageName !== undefined) source.imageName = string(sourceValue.imageName, 'draft.source.imageName');
  if (sourceValue.demo !== undefined) { if (typeof sourceValue.demo !== 'boolean') throw new Error('draft.source.demo 必须是布尔值'); source.demo = sourceValue.demo; }
  const unknown = array(v.unknown, 'draft.unknown').map((item, index) => { const row = object(item, `draft.unknown.${index}`); return { path: string(row.path, `draft.unknown.${index}.path`), label: string(row.label, `draft.unknown.${index}.label`) }; });
  const uncertain = array(v.uncertain, 'draft.uncertain').map((item, index) => string(item, `draft.uncertain.${index}`));
  const warnings = array(v.warnings, 'draft.warnings').map((item, index) => string(item, `draft.warnings.${index}`));
  const scene = parseScene(v.scene);
  const known = array(v.known, 'draft.known').map((item, index) => draftItem(item, `draft.known.${index}`));
  const assumed = array(v.assumed, 'draft.assumed').map((item, index) => draftItem(item, `draft.assumed.${index}`));
  [...known, ...assumed, ...unknown].forEach((item) => { if (!validDraftPath(scene, item.path)) throw new Error(`draft 路径不存在：${item.path}`); });
  uncertain.forEach((path) => { if (!validDraftPath(scene, path)) throw new Error(`draft.uncertain 路径不存在：${path}`); });
  return { source, scene, known, assumed, unknown, uncertain, warnings };
}
