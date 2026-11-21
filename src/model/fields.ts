import type { Body, Field, FieldKind, FieldPlayback, FieldShape, Vec2 } from './types';

export const FIELD_LABELS: Record<FieldKind, string> = {
  uniform_gravity: '匀强重力场', uniform_electric: '匀强电场', uniform_magnetic: '匀强磁场',
  point_mass: '点质量引力场', point_charge: '点电荷电场',
};
export const FIELD_COLORS: Record<FieldKind, string> = {
  uniform_gravity: '#047857', uniform_electric: '#2563eb', uniform_magnetic: '#7c3aed', point_mass: '#047857', point_charge: '#2563eb',
};
export const DEFAULT_FIELD_PLAYBACK: FieldPlayback = { duration: 30, exit: 'continue', fieldId: null, afterExit: 0 };
export const isPointSource = (field: Field) => field.kind === 'point_mass' || field.kind === 'point_charge';
export const isCharged = (body: Body) => body.charged ?? (body.charge !== undefined && body.charge !== 0);
export const hasGradient = (field: Field) => !isPointSource(field) && !!field.gradient;

export function fieldLabel(field: Field) {
  return hasGradient(field) ? FIELD_LABELS[field.kind].replace('匀强', '线性渐变') : FIELD_LABELS[field.kind];
}

export function vectorAt(field: Field, p: Vec2): Vec2 | null {
  const base = field.kind === 'uniform_electric' ? electricVector(field) : field.vector;
  if (!base || !hasGradient(field)) return base;
  return {
    x: base.x + (field.gradient!.x ?? 0) * (p.x - field.position.x),
    y: base.y + (field.gradient!.y ?? 0) * (p.y - field.position.y),
  };
}

export function magneticAt(field: Field, p: Vec2): number {
  return field.bz + (field.gradient?.x ?? 0) * (p.x - field.position.x)
    + (field.gradient?.y ?? 0) * (p.y - field.position.y);
}

export function electricVector(field: Field): Vec2 | null {
  const { plates, shape } = field;
  if (!plates || field.kind !== 'uniform_electric') return field.vector;
  if (shape.kind !== 'rect' || (plates.axis !== 'x' && plates.axis !== 'y') ||
      plates.voltage === null || !Number.isFinite(plates.voltage)) return null;
  const distance = plates.axis === 'x' ? shape.width : shape.height;
  const strength = plates.voltage / distance;
  if (!(distance > 0) || !Number.isFinite(strength)) return null;
  return plates.axis === 'x' ? { x: strength, y: 0 } : { x: 0, y: strength };
}
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const sub = (a: Vec2, b: Vec2) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2) => ({ x: a.x + b.x, y: a.y + b.y });
const eps = 1e-9;

export function shapeVertices(shape: FieldShape): Vec2[] {
  if (shape.kind === 'polygon') return shape.vertices;
  if (shape.kind !== 'rect') return [];
  const { center: c, width: w, height: h } = shape;
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => ({ x: c.x + x*w/2, y: c.y + y*h/2 }));
}

export function shapeCenter(shape: FieldShape, fallback: Vec2): Vec2 {
  if (shape.kind === 'global') return fallback;
  if (shape.kind !== 'polygon') return shape.center;
  const { vertices } = shape;
  return vertices.length ? { x: vertices.reduce((a,p) => a+p.x,0)/vertices.length, y: vertices.reduce((a,p) => a+p.y,0)/vertices.length } : fallback;
}

export function translateShape(shape: FieldShape, delta: Vec2): FieldShape {
  if (shape.kind === 'global') return shape;
  if (shape.kind === 'polygon') return { ...shape, vertices: shape.vertices.map((p) => add(p, delta)) };
  return { ...shape, center: add(shape.center, delta) };
}

export function defaultShape(kind: FieldShape['kind'], center: Vec2): FieldShape {
  if (kind === 'global') return { kind };
  if (kind === 'circle') return { kind, center, radius: 2 };
  if (kind === 'rect') return { kind, center, width: 6, height: 4 };
  return { kind, vertices: shapeVertices(defaultShape('rect', center)) };
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const d = sub(b,a);
  const u = Math.max(0,Math.min(1,dot(sub(p,a),d)/(dot(d,d)||1)));
  return Math.hypot(p.x-a.x-u*d.x,p.y-a.y-u*d.y);
}

function segmentRoots(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number[] {
  const u = sub(b,a), v = sub(d,c), w = sub(c,a);
  const det = cross(u,v);
  if (Math.abs(det) <= Number.EPSILON * Math.hypot(u.x,u.y) * Math.hypot(v.x,v.y) * 16) {
    if (distanceToSegment(c,a,b) <= eps || distanceToSegment(d,a,b) <= eps
        || distanceToSegment(a,c,d) <= eps || distanceToSegment(b,c,d) <= eps) {
      return [dot(w,u)/(dot(u,u)||1), dot(sub(d,a),u)/(dot(u,u)||1)].map(t=>Math.max(0,Math.min(1,t)));
    }
    return [];
  }
  const t = cross(w,v)/det, s = cross(w,u)/det;
  return t >= -eps && t <= 1+eps && s >= -eps && s <= 1+eps ? [Math.max(0,Math.min(1,t))] : [];
}

export function validPolygon(v: Vec2[]): boolean {
  if (v.length < 3 || !v.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
  let area = 0;
  for (let i=0;i<v.length;i++) {
    const a=v[i], b=v[(i+1)%v.length], d=sub(b,a);
    if (Math.hypot(d.x,d.y)<=eps || v.some((p,j)=>j!==i && Math.hypot(p.x-a.x,p.y-a.y)<=eps)) return false;
    const next=sub(v[(i+2)%v.length],b);
    if (Math.abs(cross(d,next)) <= eps && dot(d,next)<0) return false;
    area += cross(sub(a,v[0]),sub(b,v[0]));
    for (let j=i+2;j<v.length;j++) {
      if (i===0 && j===v.length-1) continue;
      if (segmentRoots(a,b,v[j],v[(j+1)%v.length]).length) return false;
    }
  }
  return Math.abs(area)>eps*eps;
}

export function boundaryDistance(shape: FieldShape, p: Vec2): number {
  if (shape.kind === 'global') return Infinity;
  if (shape.kind === 'circle') return Math.abs(Math.hypot(p.x-shape.center.x,p.y-shape.center.y)-shape.radius);
  const v = shapeVertices(shape);
  return Math.min(...v.map((a,i)=>distanceToSegment(p,a,v[(i+1)%v.length])));
}

export function contains(shape: FieldShape, p: Vec2): boolean {
  if (shape.kind === 'global') return true;
  if (shape.kind === 'rect') return Math.abs(p.x-shape.center.x)<=shape.width/2 && Math.abs(p.y-shape.center.y)<=shape.height/2;
  if (shape.kind === 'circle') return Math.hypot(p.x-shape.center.x,p.y-shape.center.y)<=shape.radius;
  let inside = false;
  const v = shape.vertices;
  for (let i=0,j=v.length-1;i<v.length;j=i++) {
    const a=v[i], b=v[j];
    if (distanceToSegment(p,a,b)<1e-12) return true;
    if ((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
  }
  return inside;
}

/** 线段与边界的参数交点；保留进入和离开，同点合并由调用者处理。 */
export function boundaryRoots(shape: FieldShape, a: Vec2, b: Vec2): number[] {
  if (shape.kind === 'global') return [];
  if (shape.kind === 'circle') {
    const d=sub(b,a), p=sub(a,shape.center), dd=dot(d,d);
    if (!dd) return [];
    const mid=-dot(p,d)/dd;
    const perpendicular=cross(p,d)/Math.sqrt(dd);
    const diff=(shape.radius**2-perpendicular**2)/dd;
    if (diff<0) return [];
    const h=Math.sqrt(diff);
    return [mid-h,mid+h].filter(t=>t>=-eps&&t<=1+eps).map(t=>Math.max(0,Math.min(1,t)));
  }
  const v=shapeVertices(shape);
  return v.flatMap((p,i)=>segmentRoots(a,b,p,v[(i+1)%v.length]));
}
