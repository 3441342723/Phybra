import { boundaryDistance, boundaryRoots, contains, distanceToSegment, magneticAt, shapeVertices, vectorAt } from '../model/fields';
import type { Field, FieldShape, Link, Vec2 } from '../model/types';

// State: x, y, vx, vy, work by gravity, work by the electric field.
export type State = [number, number, number, number, number, number];
export type Forces = { gx: number; gy: number; ex: number; ey: number; bz: number };
export type Segment = { start: number; end: number; at: (dt: number) => State; active: Set<string> };
export const point = (s: State) => ({ x: s[0], y: s[1] });
export const near = (a: number, b: number) => Math.abs(a-b) <= 1e-10 * Math.max(Math.abs(a),Math.abs(b),1);

export function sumFields(fields: Field[], active: Set<string>, s: State): Forces {
  const f = { gx: 0, gy: 0, ex: 0, ey: 0, bz: 0 };
  const p=point(s);
  for (const field of fields) {
    if (!active.has(field.id)) continue;
    switch(field.kind) {
      case 'uniform_gravity': {
        const g=vectorAt(field,p)!;
        f.gx+=g.x; f.gy+=g.y; break;
      }
      case 'uniform_electric': {
        const e=vectorAt(field,p)!;
        f.ex+=e.x; f.ey+=e.y; break;
      }
      case 'uniform_magnetic': f.bz+=magneticAt(field,p); break;
      default: {
        const x=s[0]-field.position.x, y=s[1]-field.position.y;
        // RK trial stages can probe beyond the protection boundary. Never evaluate the singularity.
        const r=Math.max(Math.hypot(x,y),field.cutoffRadius);
        const k=field.sourceStrength / r / r / r;
        if(field.kind==='point_mass') { f.gx-=6.67430e-11*k*x; f.gy-=6.67430e-11*k*y; }
        else { f.ex+=8.9875517923e9*k*x; f.ey+=8.9875517923e9*k*y; }
      }
    }
  }
  return f;
}

export function acceleration(s: State, f: Forces, qm: number, link?: Link) {
  const x=f.gx+qm*(f.ex+s[3]*f.bz), y=f.gy+qm*(f.ey-s[2]*f.bz);
  if (!link) return { x,y, radial: 0 };
  const r=Math.hypot(s[0]-link.anchor.x,s[1]-link.anchor.y);
  const nx=(s[0]-link.anchor.x)/r, ny=(s[1]-link.anchor.y)/r;
  const radial=x*nx+y*ny+(s[2]**2+s[3]**2)/link.length;
  return { x:x-radial*nx, y:y-radial*ny, radial };
}

export function uniformFlow(s: State, f: Forces, mass: number, q: number): (t: number) => State {
  const a=f.gx+q/mass*f.ex, b=f.gy+q/mass*f.ey, w=q/mass*f.bz;
  return (t) => {
    const z=w*t;
    const sin=Math.sin(z), cos=Math.cos(z);
    const sinc=Math.abs(z)<1e-4 ? 1-z*z/6+z**4/120 : sin/z;
    const cosc=Math.abs(z)<1e-4 ? z/2-z**3/24+z**5/720 : (1-cos)/z;
    const ds=Math.abs(z)<1e-4 ? 0.5-z*z/24+z**4/720 : (1-cos)/(z*z);
    const dc=Math.abs(z)<1e-4 ? z/6-z**3/120+z**5/5040 : (1-sinc)/z;
    const x=t*(s[2]*sinc+s[3]*cosc)+t*t*(a*ds+b*dc);
    const y=t*(s[3]*sinc-s[2]*cosc)+t*t*(b*ds-a*dc);
    return [s[0]+x,s[1]+y,s[2]*cos+s[3]*sin+t*(a*sinc+b*cosc),
      s[3]*cos-s[2]*sin+t*(b*sinc-a*cosc),s[4]+mass*(f.gx*x+f.gy*y),s[5]+q*(f.ex*x+f.ey*y)];
  };
}

function offset(s: State, d: State, dt: number): State { return s.map((v,i)=>v+dt*d[i]) as State; }

function rk4(s: State, h: number, diff: (s: State)=>State): State {
  const k1=diff(s), k2=diff(offset(s,k1,h/2)), k3=diff(offset(s,k2,h/2)), k4=diff(offset(s,k3,h));
  return s.map((v,i)=>v+h*(k1[i]+2*k2[i]+2*k3[i]+k4[i])/6) as State;
}

export function rkFlow(s: State, fields: Field[], active: Set<string>, mass: number, q: number, link?: Link) {
  const diff=(u: State): State => {
    const f=sumFields(fields,active,u), a=acceleration(u,f,q/mass,link);
    return [u[2],u[3],a.x,a.y,mass*(f.gx*u[2]+f.gy*u[3]),q*(f.ex*u[2]+f.ey*u[3])];
  };
  const project=(v: State): State => {
    if (!link) return v;
    const r=Math.hypot(v[0]-link.anchor.x,v[1]-link.anchor.y);
    const nx=(v[0]-link.anchor.x)/r, ny=(v[1]-link.anchor.y)/r;
    const vr=nx*v[2]+ny*v[3];
    return [link.anchor.x+link.length*nx,link.anchor.y+link.length*ny,v[2]-vr*nx,v[3]-vr*ny,v[4],v[5]];
  };
  const coarse=(h: number)=>rk4(s,h,diff);
  const fine=(h: number)=>rk4(rk4(s,h/2,diff),h/2,diff);
  return {
    at: (h: number)=>h===0?s:project(fine(h)),
    error(h: number) {
      const a=coarse(h), b=fine(h);
      return Math.max(...a.slice(0,4).map((v,i)=>Math.abs(v-b[i])/(1e-8+1e-8*Math.max(Math.abs(s[i]),Math.abs(b[i])))));
    },
  };
}

export type Boundary = { id: string; shape: FieldShape; source?: Field };

// Split a polynomial at its stationary points. Each resulting monotonic
// interval contains at most one crossing; tangent roots are kept for side checks.
function roots01(raw: number[]): number[] {
  const max=Math.max(...raw.map(Math.abs));
  if(max===0||!Number.isFinite(max)) return [];
  const p=raw.map(c=>c/max);
  while(p.length>1&&Math.abs(p.at(-1)!)<1e-15)p.pop();
  if(p.length<=1)return [];
  if(p.length===2) {
    const r=-p[0]/p[1];
    return r>=0&&r<=1?[r]:[];
  }
  const value=(t:number)=>p.reduceRight((v,c)=>v*t+c,0);
  const cuts=[0,...roots01(p.slice(1).map((c,i)=>c*(i+1))),1];
  const roots=cuts.filter(t=>Math.abs(value(t))<1e-13);
  for(let i=1;i<cuts.length;i++){
    let lo=cuts[i-1],hi=cuts[i];
    const v=value(lo);
    if(v*value(hi)>=0) continue;
    for(let j=0;j<48;j++){const m=(lo+hi)/2;if(value(m)*v>0)lo=m;else hi=m;}
    roots.push((lo+hi)/2);
  }
  return roots;
}

function parabolicRoots(shape: FieldShape, at:(t:number)=>State, h:number, a:Vec2): number[] {
  const s=at(0), x=[s[0],s[2]*h,a.x*h*h/2], y=[s[1],s[3]*h,a.y*h*h/2];
  if(shape.kind==='circle'){
    x[0]-=shape.center.x;y[0]-=shape.center.y;
    const polys=[0,0,0,0,0];
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)polys[i+j]+=x[i]*x[j]+y[i]*y[j];
    polys[0]-=shape.radius**2;
    return roots01(polys).map(t=>t*h);
  }
  const v=shapeVertices(shape);
  return v.flatMap((p,i)=>{
    const q=v[(i+1)%v.length], dx=q.x-p.x,dy=q.y-p.y;
    return roots01(x.map((c,j)=>dx*(y[j]-(j===0?p.y:0))-dy*(c-(j===0?p.x:0))))
      .map(t=>t*h).filter(t=>distanceToSegment(point(at(t)),p,q)<=1e-7);
  });
}

/** Candidate times come from chord intersections and samples, so a thin zone can be
 * crossed twice in one step even when both ends lie outside. Refine on the actual flow. */
export function firstCrossing(boundary: Boundary, wasInside: boolean, at: (t: number)=>State, h: number, parabolic?: Vec2): number | null {
  const n=4;
  const points=Array.from({length:n+1},(_,i)=>point(at(h*i/n)));
  const cuts=[0,h];
  if(parabolic) cuts.push(...parabolicRoots(boundary.shape,at,h,parabolic));
  for(let i=0;i<n;i++) {
    cuts.push(h*i/n);
    if(!parabolic)for(const u of boundaryRoots(boundary.shape,points[i],points[i+1])) cuts.push(h*(i+u)/n);
  }
  cuts.sort((a,b)=>a-b);
  const probes=cuts.flatMap((t,i)=>i && t>cuts[i-1] ? [(t+cuts[i-1])/2,t] : []);
  let last=0;
  const stable=(p: Vec2)=>boundaryDistance(boundary.shape,p)>1e-11;
  for(const t of probes) {
    const p=point(at(t));
    if (!stable(p)) continue;
    if (contains(boundary.shape,p)===wasInside) { last=t; continue; }
    if(last===0 && boundaryDistance(boundary.shape,points[0])<=1e-11) return 0;
    let lo=last, hi=t;
    for(let iter=0;iter<52;iter++) {
      const mid=(lo+hi)/2;
      if(mid===lo||mid===hi) break;
      if(contains(boundary.shape,point(at(mid)))===wasInside) lo=mid;
      else hi=mid;
    }
    // The next flow must start on the new side; a midpoint on the old side
    // can make the same boundary appear to be crossed again.
    return hi;
  }
  if(!stable(points[n])) {
    const next=point(at(h+Math.max(1e-11,h*1e-6)));
    if(stable(next)&&contains(boundary.shape,next)!==wasInside)return h;
  }
  return null;
}

export function segmentStep(s: State, f: Forces, qm: number, boundaries: Boundary[], link?: Link): number {
  let h=0.05;
  const omega=Math.abs(qm*f.bz);
  if(omega>0) h=Math.min(h,0.08/omega);
  const a=acceleration(s,f,qm,link);
  const speed=Math.hypot(s[2],s[3]), accel=Math.hypot(a.x,a.y);
  for(const boundary of boundaries) {
    if(!boundary.source) continue;
    const r=Math.hypot(s[0]-boundary.source.position.x,s[1]-boundary.source.position.y);
    const width=Math.max(r,boundary.source.cutoffRadius)*0.15;
    if (speed>0) h=Math.min(h,width/speed);
    if (accel>0) h=Math.min(h,Math.sqrt(width/accel));
  }
  return h;
}
