import { describe, expect, it } from 'vitest';
import { ballThrowExample, baseScene, ELECTROMAGNETIC_EXAMPLES, EXAMPLES, makeAsk, makeBall, makeField, makeLink, projectileExample } from '../src/model/factory';
import { boundaryRoots, contains, DEFAULT_FIELD_PLAYBACK, validPolygon } from '../src/model/fields';
import type { Field, FieldShape, Scene } from '../src/model/types';
import { solve } from '../src/solver';
import { isScene } from '../src/state/persist';
import { initStore, reducer } from '../src/state/store';
import { answer, ok } from './helpers';

const global={kind:'global'} as const;
const rect=(x:number,y:number,width:number,height=10):FieldShape=>({kind:'rect',center:{x,y},width,height});
const circle=(x:number,y:number,radius:number):FieldShape=>({kind:'circle',center:{x,y},radius});

function scene(fields: Field[] = []): Scene {
  const sc=baseScene();
  sc.bodies=[makeBall({x:0,y:0},1,1,0)];
  sc.fields=fields;
  return sc;
}

describe('独立物体与叠加场',()=>{
  it('小球与竖直重力场自动选择抛体求解，结果与旧文件一致',()=>{
    const old=ok(solve(projectileExample()));
    const current=ok(solve(ballThrowExample()));
    expect(current.template).toBe('projectile');
    expect(current.tEnd).toBe(old.tEnd);
    expect(current.evalAt(1)).toMatchObject({x:old.evalAt(1).x,y:old.evalAt(1).y,ay:-9.8});
    expect(isScene(projectileExample())).toBe(true);
  });

  it('电场和重力矢量叠加，可抵消或共同做功',()=>{
    const g={...makeField('uniform_gravity',{x:0,y:0},global),vector:{x:0,y:-2}};
    const e={...makeField('uniform_electric',{x:0,y:0},global),vector:{x:2,y:2}};
    const sol=ok(solve(scene([g,e])));
    expect(sol.evalAt(2)).toMatchObject({x:6,y:0,vx:5,vy:0,ax:2,ay:0});
    const energy=sol.energy;
    if(energy?.status!=='ready') throw Error('Missing energy data');
    expect(energy.workBetween(0,2)).toMatchObject({gravity:0,electric:12,kineticChange:12,balance:'verified'});
  });

  it.each([1,-1])('正负电荷磁场旋向正确，速率保持不变：q=%s',(q)=>{
    const sc=scene([makeField('uniform_magnetic',{x:0,y:0},global)]);
    sc.bodies[0].charge=q;
    const sol=ok(solve(sc)), st=sol.evalAt(Math.PI/2);
    expect(sol.tEnd).toBeCloseTo(2*Math.PI);
    expect(st.x).toBeCloseTo(1);
    expect(st.y).toBeCloseTo(-q);
    expect(Math.hypot(st.vx,st.vy)).toBeCloseTo(1);
    expect(answer(sol,'gyro_radius').value).toBeCloseTo(1);
  });

  it('交叉场速度选择和解析查询不受展示时长限制',()=>{
    const e={...makeField('uniform_electric',{x:0,y:0},global),vector:{x:0,y:1}};
    const sc=scene([e,makeField('uniform_magnetic',{x:0,y:0},global)]);
    const ask=makeAsk('at_time',{t:10});sc.asks=[ask];
    const sol=ok(solve(sc));
    expect(sol.evalAt(2)).toMatchObject({x:2,y:0,vx:1,vy:0});
    expect(answer(sol,ask.id+'.x').value).toBeCloseTo(10);
    expect(answer(sol,'selector_speed').value).toBe(1);
  });

  it('矩形与圆重叠：指定场退出后仍由另一场加速；并集策略稍后停止',()=>{
    const a={...makeField('uniform_electric',{x:0,y:0},rect(5,0,10)),vector:{x:0,y:0}};
    const b={...makeField('uniform_electric',{x:0,y:0},circle(11,0,3)),vector:{x:1,y:0}};
    const sc=scene([a,b]), ask=makeAsk('field_exit');sc.asks=[ask];
    sc.fieldPlayback={...DEFAULT_FIELD_PLAYBACK,exit:'field',fieldId:a.id,afterExit:0};
    const stop=ok(solve(sc)), t=answer(stop,ask.id).value!;
    expect(t).toBeGreaterThan(6);
    expect(stop.tEnd).toBeCloseTo(t);
    sc.fieldPlayback.afterExit=1;
    const next=ok(solve(sc));
    expect(answer(next,ask.id).value).toBeCloseTo(t,9);
    expect(next.evalAt(t+0.2).vx).toBeGreaterThan(next.evalAt(t).vx);
    sc.fieldPlayback={...DEFAULT_FIELD_PLAYBACK,exit:'union'};
    const union=ok(solve(sc));
    expect(union.tEnd).toBeGreaterThan(t);
    expect(union.evalAt(union.tEnd).x).toBeCloseTo(14,8);
  });

  it('擦过圆不算进入；边界向外出场时间为零；场外起步须先进入',()=>{
    const f={...makeField('uniform_electric',{x:0,y:0},circle(2,1,1)),vector:{x:0,y:0}};
    const sc=scene([f]), ask=makeAsk('field_exit');sc.asks=[ask];
    sc.fieldPlayback={duration:5,exit:'union',fieldId:null,afterExit:0};
    expect(answer(ok(solve(sc)),ask.id).value).toBeNull();
    f.shape=circle(2,0,1);
    expect(answer(ok(solve(sc)),ask.id).value).toBeCloseTo(3,8);
    sc.bodies[0].pos.x=3;
    expect(answer(ok(solve(sc)),ask.id).value).toBe(0);
  });

  it('同一位置的两段边界一起切换，继续穿越后能再次进场',()=>{
    const f=(x:number)=>({...makeField('uniform_electric',{x:0,y:0},rect(x,0,2)),vector:{x:0,y:0}});
    const a=f(0), b=f(2), sc=scene([a,b,{...makeField('uniform_electric',{x:0,y:0},global),vector:{x:-0.2,y:0}}]);
    sc.fieldPlayback={...DEFAULT_FIELD_PLAYBACK,duration:12};
    const changes=ok(solve(sc)).events.filter(e=>e.kind==='field_crossing');
    expect(changes[0].fieldIds).toEqual([a.id,b.id]);
    expect(changes[1].label).toContain('进入');
    expect(changes[1].fieldIds).toEqual([b.id,a.id]);
  });

  it('凹多边形保留凹口并拒绝自交',()=>{
    const vertices=[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:2,y:2},{x:0,y:4}];
    const shape={kind:'polygon',vertices} as const;
    expect(validPolygon(vertices)).toBe(true);
    expect(contains(shape,{x:2,y:3})).toBe(false);
    expect(boundaryRoots(shape,{x:-1,y:3},{x:5,y:3})).toHaveLength(4);
    expect(validPolygon([vertices[0],vertices[2],vertices[1],vertices[4]])).toBe(false);
  });

  it('点源吸引、排斥和裁剪，吸引时在最小距离停止',()=>{
    const f={...makeField('point_charge',{x:2,y:0},circle(2,0,1.5)),cutoffRadius:0.1,sourceStrength:1e-10};
    const sc=scene([f]);sc.bodies[0].charge=-1;
    const sol=ok(solve(sc));
    expect(sol.evalAt(0.1).ax).toBe(0);
    expect(sol.evalAt(0.6).ax).toBeGreaterThan(0);
    expect(sol.events.at(-1)?.kind).toBe('source_cutoff');
    expect(sol.evalAt(sol.tEnd).x).toBeCloseTo(1.9,7);
    sc.bodies[0].charge=1;
    expect(ok(solve(sc)).evalAt(0.6).ax).toBeLessThan(0);
  });

  it('定点杆和绷紧的绳从小球初速度推出圆周运动',()=>{
    const sc=scene();
    sc.bodies[0].pos={x:2,y:0};sc.bodies[0].vel={x:0,y:2};
    for(const kind of ['rope','rod'] as const){
      sc.links=[makeLink(kind,{x:0,y:0},sc.bodies[0].id,2)];
      const st=ok(solve(sc)).evalAt(Math.PI/2);
      expect(st.x).toBeCloseTo(0,7);
      expect(st.y).toBeCloseTo(2,7);
      expect(Math.hypot(st.vx,st.vy)).toBeCloseTo(2,7);
    }
  });

  it('新场景可通过 JSON 往返，场编辑可撤销',()=>{
    const sc=scene([makeField('point_mass',{x:2,y:0},global)]);
    const copy=JSON.parse(JSON.stringify(sc));
    expect(isScene(copy)).toBe(true);
    const store=initStore(copy), next={...copy,fields:[],rev:copy.rev+1};
    expect(reducer(reducer(store,{type:'apply',scene:next}),{type:'undo'}).present).toEqual(copy);
    expect(ok(solve(copy)).evalAt(0).ax).toBeGreaterThan(0);
  });

  it('点质量提供平方反比引力，配切向速度产生圆轨道',()=>{
    const sc=EXAMPLES.find(example=>example.id==='gravity-orbit')!.build();
    const sol=ok(solve(sc));
    expect(sol.evalAt(0).ax).toBeCloseTo(-2,8);
    expect(sol.evalAt(Math.PI/2).x).toBeCloseTo(4,6);
    expect(sol.evalAt(Math.PI/2).y).toBeCloseTo(6,6);
    sc.bodies[0].pos.x=8;
    expect(ok(solve(sc)).evalAt(0).ax).toBeCloseTo(-0.5,8);
  });

  it.each(['uniform_gravity','uniform_electric'] as const)('线性渐变 %s 在力与位移成正比时给出简谐运动',kind=>{
    const f={...makeField(kind,{x:2,y:0},global),vector:{x:0,y:0},gradient:{x:-4,y:0}};
    const sc=scene([f]);
    sc.bodies[0].pos.x=3;
    sc.bodies[0].vel.x=0;
    const sol=ok(solve(sc));
    const t=Math.PI/4;
    expect(sol.evalAt(t).x).toBeCloseTo(2,7);
    expect(sol.evalAt(t).vx).toBeCloseTo(-2,7);
    expect(sol.energy?.status).toBe('ready');
    if(sol.energy?.status==='ready'){
      const w=sol.energy.workBetween(0,t);
      expect(w?.net).toBeCloseTo(2,7);
      expect(w?.mechanicalChange).toBeCloseTo(0,7);
      expect(w?.balance).toBe('verified');
    }
  });

  it('渐变磁场按当前位置改变加速度，磁力仍不做功',()=>{
    const sc=ELECTROMAGNETIC_EXAMPLES.find(example=>example.id==='gradient-magnet')!.build();
    const sol=ok(solve(sc));
    const st=sol.evalAt(1);
    const bz=1+0.25*(st.x-4);
    expect(st.x).toBeGreaterThan(4);
    expect(st.ay).toBeCloseTo(-st.vx*bz,8);
    expect(Math.hypot(st.vx,st.vy)).toBeCloseTo(3,7);
    expect(sol.answers.some(a=>a.id==='gyro_radius')).toBe(false);
  });

  it('多边形裁剪的渐变电场只在区内生效',()=>{
    const shape={kind:'polygon' as const,vertices:[{x:0,y:-1},{x:2,y:-1},{x:2,y:1},{x:0,y:1}]};
    const field={...makeField('uniform_electric',{x:0,y:0},shape),vector:{x:0,y:0},gradient:{x:1,y:0}};
    const sc=scene([field]);
    sc.asks=[makeAsk('field_exit',{fieldId:field.id})];
    const sol=ok(solve(sc));
    const t=answer(sol,sc.asks[0].id).value!;
    expect(t).toBeCloseTo(Math.asinh(2),7);
    expect(sol.evalAt(t+1).vx).toBeCloseTo(Math.sqrt(5),7);
    expect(sol.evalAt(t+1).ax).toBe(0);
  });

  it('关闭带电保留输入，不受电磁力；重新启用负电荷后方向反转',()=>{
    const field={...makeField('uniform_electric',{x:0,y:0},global),vector:{x:2,y:0}};
    const sc=scene([field]);
    sc.bodies[0]={...sc.bodies[0],charged:false,charge:-1};
    expect(ok(solve(sc)).evalAt(1).vx).toBe(1);
    sc.bodies[0].charged=true;
    expect(ok(solve(sc)).evalAt(1).vx).toBe(-1);
    sc.bodies[0].charge=null;
    expect(solve(sc)).toMatchObject({ok:false,report:{blockers:[{path:`bodies.${sc.bodies[0].id}.charge`}]}});
  });
});

describe('半空间场边界返回（DEF-032）',()=>{
  it('多边形半空间场中圆周恰在边界返回，仍输出首返时刻与离地高度',()=>{
    const sc=baseScene('半空间返回');
    sc.bodies=[makeBall({x:0,y:0.8},0.0001,15/7,0)];
    sc.bodies[0].mass=0.1;sc.bodies[0].charged=true;
    const half:FieldShape={kind:'polygon',vertices:[{x:0,y:-1},{x:10000,y:-1},{x:10000,y:10000},{x:0,y:10000}]};
    const g=makeField('uniform_gravity',{x:0,y:0},{kind:'global'});g.vector={x:0,y:-10};
    const e=makeField('uniform_electric',{x:0,y:0},half);e.vector={x:0,y:10000};
    const b=makeField('uniform_magnetic',{x:0,y:0},half);b.vector={x:0,y:0};b.bz=-0.5;
    sc.fields=[g,e,b];
    sc.fieldPlayback={...DEFAULT_FIELD_PLAYBACK,duration:2000*Math.PI,exit:'continue'};
    sc.asks=[makeAsk('return_to_initial_x',{y:0})];
    const sol=ok(solve(sc));
    expect(answer(sol,sc.asks[0].id).value).toBeCloseTo(2000*Math.PI,0);
    expect(answer(sol,sc.asks[0].id+'.y').value).toBeCloseTo(0.8+60000/7,0);
  });
});
