import type { Ask, AskKind, Body, Contact, Scene, Support } from './types';

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Date.now().toString(36).slice(-3)}`;
}

export function baseScene(title = '未命名场景'): Scene {
  return { version: 2, rev: 0, title, gravity: 9.8, bodies: [], supports: [], contacts: [], asks: [], params: [], bindings: {} };
}

export function makeSupport(kind: Support['kind'], a = { x: 0, y: 0 }, length = 5, angleDeg = 0): Support {
  return { id: uid('s'), name: kind === 'incline' ? '斜面' : '水平面', kind, a, length, angleDeg };
}

export function makeBlock(support: string, s: number | null): Body {
  return {
    id: uid('b'), kind: 'block', name: '滑块',
    attach: { support, s }, pos: { x: null, y: null },
    vel: { x: 0, y: 0 }, mass: 1, accel: null,
  };
}

export function makeProjectile(x = 0, y = 2, vx = 6, vy = 8): Body {
  return {
    id: uid('b'), kind: 'projectile', name: '抛体',
    attach: null, pos: { x, y }, vel: { x: vx, y: vy }, mass: null, accel: null,
  };
}

export function makeContact(body: string, support: string, mu_s: number | null = null, mu_k: number | null = null): Contact {
  return { id: uid('c'), body, support, mu_s, mu_k };
}

export function makeAsk(kind: AskKind, extra: Partial<Ask> = {}): Ask {
  return { id: uid('a'), kind, t: null, x: null, y: null, v: null, ...extra };
}

export function inclineExample(): Scene {
  const sc = baseScene('斜面与摩擦（示例）');
  const sup = makeSupport('incline', { x: 0, y: 0 }, 5, 30);
  const block = makeBlock(sup.id, 5);
  const contact = makeContact(block.id, sup.id, 0.4, 0.3);
  sc.supports = [sup];
  sc.bodies = [block];
  sc.contacts = [contact];
  sc.asks = [makeAsk('end_of_support'), makeAsk('friction_state')];
  sc.params = [
    { name: 'theta', value: 30, unit: 'angle', min: 0, max: 60, step: 1, note: '斜面倾角' },
    { name: 'mu', value: 0.3, unit: 'none', min: 0, max: 1, step: 0.01, note: '动摩擦因数' },
  ];
  sc.bindings = { [`supports.${sup.id}.angleDeg`]: 'theta', [`contacts.${contact.id}.mu_k`]: 'mu' };
  return sc;
}

export function projectileExample(): Scene {
  const sc = baseScene('斜抛（示例）');
  sc.bodies = [makeProjectile(0, 2, 6, 8)];
  sc.asks = [makeAsk('landing'), makeAsk('apex'), makeAsk('at_height', { y: 5 })];
  return sc;
}

export function flatThrowExample(): Scene {
  const sc = baseScene('平抛（示例）');
  sc.bodies = [makeProjectile(0, 20, 10, 0)];
  sc.asks = [makeAsk('landing'), makeAsk('at_time', { t: 1 })];
  return sc;
}

export function kinematicsExample(): Scene {
  const sc = baseScene('匀变速直线运动（示例）');
  const sup = makeSupport('horizontal', { x: 0, y: 0 }, 40, 0);
  const block = makeBlock(sup.id, 0);
  block.vel = { x: 2, y: 0 };
  block.accel = 3;
  sc.supports = [sup];
  sc.bodies = [block];
  sc.contacts = [makeContact(block.id, sup.id, null, null)];
  sc.asks = [makeAsk('at_time', { t: 4 }), makeAsk('at_position', { x: 30 })];
  return sc;
}

export const EXAMPLES = [
  { id: 'incline', title: '斜面与摩擦', build: inclineExample },
  { id: 'projectile', title: '斜抛', build: projectileExample },
  { id: 'flat', title: '平抛', build: flatThrowExample },
  { id: 'kinematics', title: '匀变速直线', build: kinematicsExample },
];
