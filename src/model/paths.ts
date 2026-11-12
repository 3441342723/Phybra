import type { Scene } from './types';

const COLLECTIONS = ['bodies', 'supports', 'contacts', 'asks', 'params'] as const;

function parse(path: string): string[] {
  return path.split('.');
}

export function getAt(scene: Scene, path: string): unknown {
  const parts = parse(path);
  let cur: any = scene;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    const key = parts[i];
    if (Array.isArray(cur)) {
      cur = cur.find((item) => item.id === key || item.name === key);
    } else if (COLLECTIONS.includes(key as any) && parts.length > i + 1) {
      const id = parts[++i];
      cur = (cur as any)[key]?.find((item: any) => item.id === id || item.name === id);
    } else {
      cur = cur[key];
    }
  }
  return cur;
}

export function setAt(scene: Scene, path: string, value: unknown): Scene {
  const next = structuredClone(scene);
  const parts = parse(path);
  let cur: any = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (Array.isArray(cur)) {
      cur = cur.find((item) => item.id === key || item.name === key);
    } else if (COLLECTIONS.includes(key as any)) {
      const id = parts[++i];
      cur = cur[key]?.find((item: any) => item.id === id || item.name === id);
    } else {
      cur = cur[key];
    }
    if (cur === undefined || cur === null) throw new Error(`无效路径: ${path}`);
  }
  cur[parts[parts.length - 1]] = value;
  next.rev = scene.rev + 1;
  return next;
}

/** 应用命名参数绑定，得到求解用的场景副本；未赋值参数保持 null */
export function resolveBindings(scene: Scene): Scene {
  let next = structuredClone(scene);
  for (const [path, paramName] of Object.entries(scene.bindings)) {
    const param = scene.params.find((p) => p.name === paramName);
    if (!param) continue;
    const parts = parse(path);
    const last = parts[parts.length - 1];
    if (last === 'value') continue;
    const raw = getAt(scene, path);
    if (typeof raw === 'number' || raw === null) {
      next = setAt(next, path, param.value);
      next.rev = scene.rev;
    }
  }
  return next;
}

export function boundParam(scene: Scene, path: string): string | undefined {
  return scene.bindings[path];
}

export function describePath(scene: Scene, path: string): string {
  const parts = parse(path);
  const [head, id] = parts;
  const field = parts.slice(2).join('.');
  const NAMES: Record<string, string> = {
    mass: '质量', accel: '加速度', angleDeg: '倾角', length: '长度', s: '沿面位置',
    mu_s: '静摩擦因数', mu_k: '动摩擦因数', value: '取值', x: 'x', y: 'y', t: '时刻 t', v: '速度 v',
    attach: '依附关系', pos: '位置', vel: '速度', support: '支撑面',
  };
  const COLL: Record<string, string> = { bodies: '物体', supports: '支撑面', contacts: '摩擦接触', asks: '待求量', params: '参数' };
  const fieldLabel = field ? field.split('.').map((f) => NAMES[f] ?? f).join('.') : '';
  if (head === 'gravity') return '重力加速度 g';
  const coll = (scene as any)[head];
  const item = Array.isArray(coll) && id ? coll.find((it: any) => it.id === id || it.name === id) : null;
  const owner = item?.name ?? (id ? `${COLL[head] ?? head} ${id}` : COLL[head] ?? path);
  return [owner, fieldLabel].filter(Boolean).join(' · ');
}
