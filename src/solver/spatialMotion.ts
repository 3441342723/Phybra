import type { Field, Vec3 } from '../model/types';

// x, y, z, vx, vy, vz, gravitational work, electric work.
export type SpatialState = [number, number, number, number, number, number, number, number];
export type SpatialForces = { g: Vec3; e: Vec3; b: Vec3 };
export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const scale3 = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const norm3 = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
export const position3 = (s: SpatialState): Vec3 => ({ x: s[0], y: s[1], z: s[2] });
export const velocity3 = (s: SpatialState): Vec3 => ({ x: s[3], y: s[4], z: s[5] });
const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });

export function spatialForces(fields: Field[], s: SpatialState): SpatialForces {
  const f = { g: zero(), e: zero(), b: zero() };
  const p = position3(s);
  for (const field of fields) {
    const d = { x: p.x - field.position.x, y: p.y - field.position.y, z: p.z - (field.position.z ?? 0) };
    if (field.kind === 'point_mass' || field.kind === 'point_charge') {
      const r = Math.max(norm3(d), field.cutoffRadius);
      const force = scale3(d, (field.kind === 'point_mass' ? -6.67430e-11 : 8.9875517923e9) * field.sourceStrength / r / r / r);
      if (field.kind === 'point_mass') f.g = add3(f.g, force);
      else f.e = add3(f.e, force);
    } else if (field.kind === 'uniform_magnetic') {
      f.b = add3(f.b, { x: field.bx ?? 0, y: field.by ?? 0, z: field.bz });
    } else {
      const vector = { x: field.vector.x + (field.gradient?.x ?? 0) * d.x,
        y: field.vector.y + (field.gradient?.y ?? 0) * d.y,
        z: (field.vector.z ?? 0) + (field.gradient?.z ?? 0) * d.z };
      if (field.kind === 'uniform_gravity') f.g = add3(f.g, vector);
      else f.e = add3(f.e, vector);
    }
  }
  return f;
}

export const spatialAcceleration = (s: SpatialState, f: SpatialForces, qm: number): Vec3 => add3(f.g, scale3(add3(f.e, cross3(velocity3(s), f.b)), qm));

/** Exact constant-field flow, including arbitrary B directions and parallel electric acceleration. */
export function spatialUniformFlow(s: SpatialState, f: SpatialForces, m: number, q: number): (t: number) => SpatialState {
  const a = add3(f.g, scale3(f.e, q / m)), v = velocity3(s), bmag = norm3(f.b), w = q / m * bmag;
  const axis = bmag ? scale3(f.b, 1 / bmag) : zero();
  const vp = scale3(axis, dot3(v, axis)), ap = scale3(axis, dot3(a, axis));
  const vt = add3(v, scale3(vp, -1)), at = add3(a, scale3(ap, -1));
  return (t) => {
    let dr: Vec3, velocity: Vec3;
    if (w === 0) {
      dr = add3(scale3(v, t), scale3(a, t * t / 2));
      velocity = add3(v, scale3(a, t));
    } else {
      const z = w * t, sin = Math.sin(z), cos = Math.cos(z);
      const small = Math.abs(z) < 1e-4;
      const sinc = small ? 1 - z*z/6 + z**4/120 : sin/z;
      const cosc = small ? z/2 - z**3/24 + z**5/720 : (1-cos)/z;
      const ds = small ? .5 - z*z/24 + z**4/720 : (1-cos)/(z*z);
      const dc = small ? z/6 - z**3/120 + z**5/5040 : (1-sinc)/z;
      dr = add3(add3(scale3(vp,t),scale3(ap,t*t/2)), add3(
        add3(scale3(vt,t*sinc),scale3(cross3(vt,axis),t*cosc)),
        add3(scale3(at,t*t*ds),scale3(cross3(at,axis),t*t*dc))));
      velocity = add3(add3(vp,scale3(ap,t)), add3(
        add3(scale3(vt,cos),scale3(cross3(vt,axis),sin)),
        add3(scale3(at,t*sinc),scale3(cross3(at,axis),t*cosc))));
    }
    return [s[0]+dr.x,s[1]+dr.y,s[2]+dr.z,velocity.x,velocity.y,velocity.z,
      s[6]+m*dot3(f.g,dr),s[7]+q*dot3(f.e,dr)];
  };
}

export function spatialRKFlow(s: SpatialState, fields: Field[], m: number, q: number) {
  const diff = (u: SpatialState): SpatialState => {
    const f = spatialForces(fields,u), a = spatialAcceleration(u,f,q/m), v = velocity3(u);
    return [v.x,v.y,v.z,a.x,a.y,a.z,m*dot3(f.g,v),q*dot3(f.e,v)];
  };
  const offset = (u: SpatialState, k: SpatialState, h: number) => u.map((v,i)=>v+h*k[i]) as SpatialState;
  const rk4 = (u: SpatialState, h: number): SpatialState => {
    const a=diff(u),b=diff(offset(u,a,h/2)),c=diff(offset(u,b,h/2)),d=diff(offset(u,c,h));
    return u.map((v,i)=>v+h*(a[i]+2*b[i]+2*c[i]+d[i])/6) as SpatialState;
  };
  const at = (h: number) => h === 0 ? s : rk4(rk4(s,h/2),h/2);
  return { at, error(h: number) {
    const coarse=rk4(s,h),fine=at(h);
    return Math.max(...coarse.map((v,i)=>Math.abs(v-fine[i])/(1e-9+1e-8*Math.max(Math.abs(s[i]),Math.abs(fine[i])))));
  } };
}
