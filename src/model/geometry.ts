import type { Body, Scene, Support, Vec2 } from './types';

export function supportAngle(s: Support): number {
  return ((s.angleDeg ?? 0) * Math.PI) / 180;
}

export function supportDir(s: Support): Vec2 {
  const th = supportAngle(s);
  return { x: Math.cos(th), y: Math.sin(th) };
}

export function supportLength(s: Support): number {
  return s.length ?? 4;
}

export function supportEnd(s: Support): Vec2 {
  const d = supportDir(s);
  const L = supportLength(s);
  return { x: s.a.x + d.x * L, y: s.a.y + d.y * L };
}

export function pointOnSupport(s: Support, along: number): Vec2 {
  const d = supportDir(s);
  return { x: s.a.x + d.x * along, y: s.a.y + d.y * along };
}

export function bodyWorld(scene: Scene, body: Body): Vec2 | null {
  if (body.attach) {
    const sup = scene.supports.find((s) => s.id === body.attach!.support);
    if (!sup) return null;
    return pointOnSupport(sup, body.attach.s ?? supportLength(sup) / 2);
  }
  if (body.pos.x === null || body.pos.y === null) return null;
  return { x: body.pos.x, y: body.pos.y };
}

/** 将世界坐标投影为沿面弧长，并夹取到 [0, L]，保证拖动不脱离斜面 */
export function projectToSupport(s: Support, p: Vec2): number {
  const d = supportDir(s);
  const raw = (p.x - s.a.x) * d.x + (p.y - s.a.y) * d.y;
  return Math.min(supportLength(s), Math.max(0, raw));
}
