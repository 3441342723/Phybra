import type { Ask, AskKind, Body, Contact, Field, FieldKind, FieldShape, Link, Scene, Support, Vec2 } from './types';
import { DEFAULT_FIELD_PLAYBACK, defaultShape, FIELD_LABELS } from './fields';

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

export function makeBall(position: Vec2, charge = 0, vx = 0, vy = 0): Body {
  return { ...makeProjectile(position.x, position.y, vx, vy), kind: 'ball', name: '小球', mass: 1, charge, collisionRadius: 0.25 };
}

export function makeField(kind: FieldKind, position: Vec2, shape: FieldShape = defaultShape(
  kind === 'uniform_gravity' || kind === 'point_mass' || kind === 'point_charge' ? 'global' : 'rect', position,
)): Field {
  return {
    id: uid('f'), kind, name: FIELD_LABELS[kind], enabled: true, position, shape,
    vector: kind === 'uniform_gravity' ? { x: 0, y: -9.8 } : { x: 0, y: -2 },
    bz: 1, sourceStrength: kind === 'point_mass' ? 1e11 : 1e-9, cutoffRadius: 0.001,
  };
}

export function makeLink(kind: Link['kind'], anchor: Vec2, bodyId: string | null, length: number): Link {
  return { id: uid('l'), kind, name: kind === 'rope' ? '绳' : '杆', anchor, bodyId, length };
}

export function fieldExample(kind: 'electric' | 'magnetic' | 'selector' | 'point'): Scene {
  const titles = { electric: '电场偏转', magnetic: '磁场出界', selector: '复合场速度选择', point: '裁剪点电荷场' };
  const sc = baseScene(titles[kind]);
  const center = { x: 4, y: 3 };
  const shape: FieldShape = kind === 'point' ? { kind: 'circle', center, radius: 3 } : { kind: 'rect', center, width: 8, height: 6 };
  const ball = makeBall({ x: 1, y: 3 }, 1, 3, 0);
  if (kind === 'point') ball.charge = -1;
  sc.bodies = [ball];
  sc.fields = kind === 'electric' ? [makeField('uniform_electric', center, shape)]
    : kind === 'magnetic' ? [makeField('uniform_magnetic', center, shape)]
    : kind === 'selector' ? [
        { ...makeField('uniform_electric', center, shape), vector: { x: 0, y: 3 } },
        makeField('uniform_magnetic', center, shape),
      ] : [makeField('point_charge', center, shape)];
  sc.fieldPlayback = { ...DEFAULT_FIELD_PLAYBACK, exit: 'union' };
  sc.asks = [makeAsk('field_exit')];
  return sc;
}

const rect = (x: number, y: number, width: number, height: number): Extract<FieldShape, { kind: 'rect' }> =>
  ({ kind: 'rect', center: { x, y }, width, height });

function platesExample(accelerating: boolean): Scene {
  const sc = baseScene(accelerating ? '平行板电场加速' : '平行板电场偏转');
  const shape = accelerating ? rect(3, 3, 6, 4) : rect(5, 4, 8, 6);
  const field: Field = {
    ...makeField('uniform_electric', shape.center, shape), name: '平行板电场',
    plates: accelerating ? { axis: 'x', voltage: 12 } : { axis: 'y', voltage: -6 },
  };
  const ball = accelerating ? makeBall({ x: 0, y: 3 }, 1) : makeBall({ x: 0, y: 4 }, 1, 4);
  ball.mass = accelerating ? 2 : 1;
  sc.bodies = [ball];
  sc.fields = [field];
  sc.fieldPlayback = { ...DEFAULT_FIELD_PLAYBACK, exit: 'union', afterExit: 1 };
  sc.asks = [
    ...(!accelerating ? [makeAsk('field_entry', { fieldId: field.id })] : []),
    makeAsk('field_exit', { fieldId: field.id }),
    makeAsk('work_between', { energyFrom: { kind: 'event', event: 'initial' }, energyTo: { kind: 'event', event: 'field_exit' } }),
  ];
  return sc;
}

function magneticReturnExample(withSelector: boolean): Scene {
  const sc = baseScene(withSelector ? '速度选择后进入磁场' : '磁场半圆返回');
  const shape = withSelector ? rect(7.5, 5, 5, 10) : rect(4.5, 5, 7, 10);
  const magnet = { ...makeField('uniform_magnetic', shape.center, shape), name: withSelector ? '偏转磁场' : '匀强磁场' };
  sc.bodies = [makeBall({ x: 0, y: 8 }, 1, 3)];
  sc.fields = [magnet];
  sc.asks = [makeAsk('field_entry', { fieldId: magnet.id }), makeAsk('field_exit', { fieldId: magnet.id })];
  if (withSelector) {
    const selector = rect(3, 7, 4, 6);
    const electric = { ...makeField('uniform_electric', selector.center, selector), name: '选择电场', vector: { x: 0, y: 3 } };
    const magnetic = { ...makeField('uniform_magnetic', selector.center, selector), name: '选择磁场' };
    sc.fields.unshift(electric, magnetic);
    sc.asks.unshift(makeAsk('field_exit', { fieldId: electric.id }));
  }
  sc.fieldPlayback = { ...DEFAULT_FIELD_PLAYBACK, exit: 'union', afterExit: 0.5 };
  return sc;
}

export function ballThrowExample(): Scene {
  const sc = baseScene('小球与重力场（斜抛）');
  sc.bodies = [makeBall({ x: 0, y: 2 }, 0, 6, 8)];
  sc.fields = [makeField('uniform_gravity', { x: 2, y: 3 }, { kind: 'global' })];
  sc.asks = [makeAsk('landing'), makeAsk('apex')];
  return sc;
}

function pointGravityExample(): Scene {
  const sc = baseScene('点质量引力场：圆轨道');
  const source = makeField('point_mass', { x: 4, y: 4 });
  source.sourceStrength = 8 / 6.67430e-11;
  sc.fields = [source];
  sc.bodies = [makeBall({ x: 6, y: 4 }, 0, 0, 2)];
  sc.fieldPlayback = { ...DEFAULT_FIELD_PLAYBACK, duration: 2 * Math.PI };
  sc.asks = [makeAsk('at_time', { t: Math.PI / 2 })];
  return sc;
}

function magneticGradientExample(): Scene {
  const sc = baseScene('线性渐变磁场');
  const field = makeField('uniform_magnetic', { x: 4, y: 4 }, { kind: 'global' });
  field.name = '线性渐变磁场';
  field.gradient = { x: 0.25, y: 0 };
  sc.fields = [field];
  sc.bodies = [makeBall({ x: 4, y: 4 }, 1, 3, 0)];
  sc.fieldPlayback = { ...DEFAULT_FIELD_PLAYBACK, duration: 8 };
  sc.asks = [makeAsk('at_time', { t: 1 })];
  return sc;
}

export function makeBoat(x = 0, y = 0, vx = 0, vy = 4, flowX = 3, width = 20): Body {
  return {
    id: uid('b'), kind: 'boat', name: '小船',
    attach: null, pos: { x, y }, vel: { x: vx, y: vy }, mass: null, accel: null,
    flow: { x: flowX, y: 0 }, width,
  };
}

export function makeCircular(cx = 0, cy = 0, radius = 5, omega = 1, phase = 0, mass: number | null = 2): Body {
  return {
    id: uid('b'), kind: 'circular', name: '圆周运动',
    attach: null, pos: { x: cx, y: cy }, vel: { x: null, y: null }, mass, accel: null,
    radius, omega, phase,
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

export function projectileInclineExample(): Scene {
  const sc = baseScene('平抛落斜面（示例）');
  sc.gravity = 10;
  const sup = makeSupport('incline', { x: 0, y: 0 }, 30, 30);
  sc.supports = [sup];
  sc.bodies = [makeProjectile(0, 15, 10, 0)];
  sc.asks = [makeAsk('at_time', { t: 1 })];
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

export function circularExample(): Scene {
  const sc = baseScene('匀速圆周运动（示例）');
  const body = makeCircular(0, 0, 5, 1, 0, 2);
  sc.bodies = [body];
  sc.asks = [makeAsk('at_time', { t: 1 })];
  sc.params = [
    { name: 'omega', value: 1, unit: 'none', min: 0.1, max: 5, step: 0.1, note: '角速度 rad/s' },
    { name: 'R', value: 5, unit: 'length', min: 1, max: 20, step: 0.5, note: '半径' },
  ];
  sc.bindings = { [`bodies.${body.id}.omega`]: 'omega', [`bodies.${body.id}.radius`]: 'R' };
  return sc;
}

export const EXAMPLES = [
  { id: 'incline', title: '斜面与摩擦', build: inclineExample },
  { id: 'projectile', title: '斜抛', build: () => editableProjectile(projectileExample()) },
  { id: 'flat', title: '平抛', build: () => editableProjectile(flatThrowExample()) },
  { id: 'projectile-incline', title: '平抛落斜面', build: () => editableProjectile(projectileInclineExample()) },
  { id: 'kinematics', title: '匀变速直线', build: kinematicsExample },
  { id: 'circular', title: '匀速圆周运动', build: editableCircularExample },
  { id: 'ball-throw', title: '小球与重力场（斜抛）', build: ballThrowExample },
  { id: 'gravity-orbit', title: '点质量引力场：圆轨道', build: pointGravityExample },
];

function editableProjectile(scene: Scene): Scene {
  scene.bodies = scene.bodies.map(b => ({...makeBall({x:b.pos.x!,y:b.pos.y!},0,b.vel.x!,b.vel.y!),mass:1}));
  const gravity=makeField('uniform_gravity',{x:2,y:3},{kind:'global'});
  gravity.vector.y=-scene.gravity!;
  scene.fields=[gravity];
  return scene;
}

function editableCircularExample(): Scene {
  const scene=baseScene('小球与定点杆：匀速圆周运动');
  const ball=makeBall({x:5,y:0},0,0,5);
  ball.mass=2;
  scene.bodies=[ball];
  scene.links=[makeLink('rod',{x:0,y:0},ball.id,5)];
  scene.fieldPlayback={...DEFAULT_FIELD_PLAYBACK,duration:2*Math.PI};
  scene.asks=[makeAsk('at_time',{t:1})];
  return scene;
}

export const DEFAULT_COLLISION = {restitution:1,afterCollision:3} as const;

export function collisionExample(kind:'elastic'|'inelastic'|'chase'|'oblique'): Scene {
  const titles={elastic:'等质量弹性对碰',inelastic:'完全非弹性正碰',chase:'不等质量追碰',oblique:'二维弹性斜碰'};
  const scene=baseScene(titles[kind]);
  const a=makeBall({x:0,y:3},0,kind==='chase'?4:3,0);
  const b=makeBall({x:6,y:kind==='oblique'?3.6:3},0,kind==='elastic'?-1:kind==='chase'?1:0,0);
  a.collisionRadius=b.collisionRadius=0.5;
  a.name='小球 A'; b.name='小球 B';
  if(kind==='inelastic'||kind==='chase') b.mass=2;
  scene.bodies=[a,b];
  scene.collision={...DEFAULT_COLLISION,restitution:kind==='inelastic'?0:kind==='chase'?0.5:1};
  scene.asks=[makeAsk('collision'),makeAsk('at_time',{t:3})];
  return scene;
}

export const COLLISION_EXAMPLES = [
  {id:'collision-elastic',title:'等质量弹性对碰',build:()=>collisionExample('elastic')},
  {id:'collision-inelastic',title:'完全非弹性正碰',build:()=>collisionExample('inelastic')},
  {id:'collision-chase',title:'不等质量追碰',build:()=>collisionExample('chase')},
  {id:'collision-oblique',title:'二维弹性斜碰',build:()=>collisionExample('oblique')},
];

export const ELECTROMAGNETIC_EXAMPLES = [
  { id: 'parallel-plate-acceleration', title: '平行板电场加速', build: () => platesExample(true) },
  { id: 'parallel-plate-deflection', title: '平行板电场偏转', build: () => platesExample(false) },
  { id: 'electric-field', title: '匀强电场偏转', build: () => fieldExample('electric') },
  { id: 'magnetic-field', title: '匀强磁场出界', build: () => fieldExample('magnetic') },
  { id: 'magnetic-return', title: '磁场半圆返回', build: () => magneticReturnExample(false) },
  { id: 'crossed-fields', title: '复合场速度选择', build: () => fieldExample('selector') },
  { id: 'selector-to-magnet', title: '速度选择后进入磁场', build: () => magneticReturnExample(true) },
  { id: 'point-field', title: '裁剪点电荷场', build: () => fieldExample('point') },
  { id: 'gradient-magnet', title: '线性渐变磁场', build: magneticGradientExample },
];
