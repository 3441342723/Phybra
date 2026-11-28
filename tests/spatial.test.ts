import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { baseScene, makeAsk, makeBall, makeField, makeLink, SPATIAL_EXAMPLES, spatialExample } from '../src/model/factory';
import { projectSpace, unprojectSpace } from '../src/model/projection';
import { resolveBindings } from '../src/model/paths';
import type { Scene } from '../src/model/types';
import { withDimension } from '../src/state/spatial';
import { initStore, reducer } from '../src/state/store';
import { withBinding, withField } from '../src/state/editing';
import { isScene } from '../src/state/persist';
import { defaultLayout, fitPlaybackCamera } from '../src/state/layout';
import { solve } from '../src/solver';
import { SpatialCanvas } from '../src/ui/SpatialCanvas';
import { answer, ok } from './helpers';

function scene(): Scene {
  const sc=baseScene('手动搭建三维场景');sc.dimension='3d';
  sc.bodies=[makeBall({x:0,y:2},1,3,0)];
  sc.bodies[0].vel.z=1;
  sc.fields=[makeField('uniform_magnetic',{x:0,y:0},{kind:'global'})];
  sc.asks=[makeAsk('at_time',{t:1})];
  return sc;
}
function close3(actual:{x:number;y:number;z?:number},expected:{x:number;y:number;z:number},digits=7){
  expect(actual.x).toBeCloseTo(expected.x,digits);expect(actual.y).toBeCloseTo(expected.y,digits);expect(actual.z).toBeCloseTo(expected.z,digits);
}

describe('三维运动求解',()=>{
  it('二维场景下 null 占位不算三维分量，非零仍拒绝（DEF-024）',()=>{
    const sc=baseScene('null 占位');sc.dimension='2d';
    sc.bodies=[makeBall({x:0,y:0},1,2,0)];
    sc.bodies[0].pos.z=null as any;sc.bodies[0].vel.z=null as any;
    const f=makeField('uniform_magnetic',{x:0,y:0},{kind:'global'});
    f.bx=null as any;f.by=null as any;f.gradient=null as any;f.bz=-0.5;
    sc.fields=[f];
    sc.asks=[makeAsk('at_time',{t:1})];
    expect(ok(solve(sc))).toBeTruthy();
    f.bx=0.1;
    expect(solve(sc).ok).toBe(false);
  });
  it('绕 +z 的螺旋线方向、半径、周期、螺距及动能正确',()=>{
    const sc=scene(),sol=ok(solve(sc)),period=2*Math.PI,s=sol.evalAt(Math.PI/2);
    close3(s,{x:3,y:-1,z:Math.PI/2});
    expect(s.vx).toBeCloseTo(0);expect(s.vy).toBeCloseTo(-3);expect(s.vz).toBe(1);
    close3(sol.evalAt(period),{x:0,y:2,z:period});
    expect(answer(sol,'gyro_radius').value).toBeCloseTo(3);
    expect(answer(sol,'gyro_period').value).toBeCloseTo(period);
    expect(answer(sol,'helix_pitch').value).toBeCloseTo(period);
    for(const s of sol.energy!.status==='ready'?sol.energy!.samples:[])expect(s.kinetic).toBeCloseTo(5,10);
  });
  it.each([-1,1])('电荷符号 %s 改变旋转方向而不改变平行速度',q=>{
    const sc=scene();sc.bodies[0].charge=q;
    const s=ok(solve(sc)).evalAt(Math.PI/2);
    expect(s.x).toBeCloseTo(3);expect(s.y).toBeCloseTo(2-q*3);expect(s.vz).toBe(1);
  });
  it('倾斜磁场保持速度模长和沿磁场速度，转一周回到平行直线上',()=>{
    const sc=scene();sc.fields![0].bx=1;sc.fields![0].by=1;
    const sol=ok(solve(sc)),T=2*Math.PI/Math.sqrt(3),s=sol.evalAt(T);
    close3(s,{x:4*T/3,y:2+4*T/3,z:4*T/3});
    for(const s of sol.samples){expect(Math.hypot(s.vx,s.vy,s.vz!)).toBeCloseTo(Math.sqrt(10),9);expect(s.vx+s.vy+s.vz!).toBeCloseTo(4,9);}
  });
  it('沿 x 的磁场旋转 y、z 速度，x 方向匀速',()=>{
    const sc=scene();sc.fields![0].bx=1;sc.fields![0].bz=0;
    const s=ok(solve(sc)).evalAt(Math.PI/2);
    close3(s,{x:3*Math.PI/2,y:3,z:1});expect(s.vy).toBeCloseTo(1);expect(s.vz).toBeCloseTo(0);
  });
  it('电场平行磁场时 z 加速，横向仍为圆周运动',()=>{
    const sc=scene(),e=makeField('uniform_electric',{x:0,y:0},{kind:'global'});e.vector={x:0,y:0,z:2};sc.fields!.push(e);
    const sol=ok(solve(sc)),s=sol.evalAt(2);
    expect(s.z).toBeCloseTo(6);expect(s.vz).toBeCloseTo(5);expect(s.az).toBe(2);
    if(sol.energy?.status!=='ready')throw new Error('缺少能量');
    expect(sol.energy.workBetween(0,2)?.electric).toBeCloseTo(12);
    expect(sol.energy.workBetween(0,2)?.balance).toBe('verified');
  });
  it('电磁漂移速度加任意平行速度时合力为零',()=>{
    const sc=scene(),e=makeField('uniform_electric',{x:0,y:0},{kind:'global'});e.vector={x:0,y:3,z:0};sc.fields!.push(e);
    const sol=ok(solve(sc)),s=sol.evalAt(2);
    close3(s,{x:6,y:2,z:2});expect(s.ax).toBeCloseTo(0);expect(s.ay).toBeCloseTo(0);expect(s.az).toBeCloseTo(0);
    expect(sol.answers.some(a=>a.id==='helix_pitch')).toBe(false);
  });
  it('零磁场下，三个方向的重力与电场按分量叠加',()=>{
    const sc=scene(),g=makeField('uniform_gravity',{x:0,y:0},{kind:'global'}),e=makeField('uniform_electric',{x:0,y:0},{kind:'global'});
    g.vector={x:1,y:-10,z:2};e.vector={x:2,y:4,z:6};sc.fields=[g,e];sc.bodies[0].mass=2;
    const sol=ok(solve(sc)),s=sol.evalAt(2);
    close3(s,{x:10,y:-14,z:12});expect(s.vz).toBe(11);
    if(sol.energy?.status!=='ready')throw new Error('缺少能量');
    const w=sol.energy.workBetween(0,2)!;
    expect(w.net).toBeCloseTo(w.kineticChange);expect(w.mechanicalChange).toBeCloseTo(0);expect(w.balance).toBe('verified');
  });
  it('中性小球不受电磁场作用，包括点电荷源中心',()=>{
    const sc=scene();sc.bodies[0].charge=0;const point=makeField('point_charge',{x:0,y:2},{kind:'global'});sc.fields!.push(point);
    const sol=ok(solve(sc));close3(sol.evalAt(2),{x:6,y:2,z:2});
    expect(sol.notice).toBeUndefined();expect(sol.energy?.status==='ready'&&sol.energy.evalAt(0)?.potential).toBe(0);
  });
  it('瞬间速度为零但受力非零时仍继续运动；平衡静止时结束',()=>{
    const sc=scene();sc.fields=[];sc.bodies[0].vel={x:0,y:0,z:0};
    expect(ok(solve(sc)).tEnd).toBe(0);
    const g=makeField('uniform_gravity',{x:0,y:0},{kind:'global'});sc.fields=[g];
    const sol=ok(solve(sc));expect(sol.tEnd).toBeGreaterThan(0);expect(sol.evalAt(1).vy).toBeCloseTo(-9.8);
  });
  it('很弱的磁场连续趋近自由运动，不出现消减误差',()=>{
    const sc=scene();sc.fields![0].bz=1e-12;sc.fieldPlayback={duration:3,exit:'continue',fieldId:null,afterExit:0};
    close3(ok(solve(sc)).evalAt(2),{x:6,y:2,z:2});
  });
  it('二维复合场是三维解析解的特例，三个维度的合功均等于动能变化',()=>{
    const sc=scene(),e=makeField('uniform_electric',{x:0,y:0},{kind:'global'}),g=makeField('uniform_gravity',{x:0,y:0},{kind:'global'});
    e.vector={x:2,y:-3,z:0};g.vector={x:1,y:-2,z:0};sc.fields!.push(e,g);sc.bodies[0].vel.z=0;
    const plane=ok(solve(withDimension(sc,'2d'))),space=ok(solve(sc));
    for(const t of [0,.4,1,2]){
      const a=plane.evalAt(t),b=space.evalAt(t);
      close3(b,{x:a.x,y:a.y,z:0},9);expect(b.vx).toBeCloseTo(a.vx,9);expect(b.vy).toBeCloseTo(a.vy,9);
    }
    sc.fields![0].bx=1;sc.fields![0].by=-2;sc.bodies[0].vel.z=2;e.vector.z=3;
    const arbitrary=ok(solve(sc));
    if(arbitrary.energy?.status!=='ready')throw new Error('缺少能量');
    const work=arbitrary.energy.workBetween(.2,2)!;expect(work.net).toBeCloseTo(work.kineticChange,8);expect(work.balance).toBe('verified');
    const h=1e-5,a=arbitrary.evalAt(1-h),b=arbitrary.evalAt(1+h),s=arbitrary.evalAt(1);
    expect((b.vx-a.vx)/(2*h)).toBeCloseTo(3+s.vy+2*s.vz!,7);
    expect((b.vy-a.vy)/(2*h)).toBeCloseTo(-5+s.vz!-s.vx,7);
    expect((b.vz!-a.vz!)/(2*h)).toBeCloseTo(3-2*s.vx-s.vy,7);
  });
  it('指定时刻超过演示时长时，匀强全局场仍给出真实答案',()=>{
    const sc=scene();sc.fieldPlayback={duration:1,exit:'continue',fieldId:null,afterExit:0};sc.asks=[makeAsk('at_time',{t:40})];
    const sol=ok(solve(sc));expect(sol.tEnd).toBe(1);expect(answer(sol,sc.asks[0].id+'.z').value).toBe(40);
  });
  it('线性 z 重力场以数值解得到简谐运动并保持能量',()=>{
    const sc=scene(),g=makeField('uniform_gravity',{x:0,y:0},{kind:'global'});
    sc.bodies[0].pos={x:0,y:0,z:1};sc.bodies[0].vel={x:0,y:0,z:0};sc.bodies[0].charge=0;
    g.vector={x:0,y:0,z:0};g.gradient={x:0,y:0,z:-1};sc.fields=[g];sc.fieldPlayback={duration:2*Math.PI,exit:'continue',fieldId:null,afterExit:0};
    const sol=ok(solve(sc));expect(sol.notice).toBeUndefined();
    expect(sol.evalAt(Math.PI).z).toBeCloseTo(-1,6);expect(sol.evalAt(2*Math.PI).z).toBeCloseTo(1,6);
    if(sol.energy?.status!=='ready')throw new Error('缺少能量');
    expect(sol.energy.evalAt(2*Math.PI)?.mechanical).toBeCloseTo(.5,7);
  });
  it('点质量源使用三维距离，倾斜轨道旋转一周闭合',()=>{
    const sc=scene(),g=makeField('point_mass',{x:0,y:0},{kind:'global'}),mu=1;
    g.sourceStrength=mu/6.67430e-11;g.cutoffRadius=.01;sc.fields=[g];sc.bodies[0].charge=0;
    sc.bodies[0].pos={x:1,y:0,z:0};sc.bodies[0].vel={x:0,y:Math.SQRT1_2,z:Math.SQRT1_2};sc.fieldPlayback={duration:2*Math.PI,exit:'continue',fieldId:null,afterExit:0};
    const sol=ok(solve(sc));close3(sol.evalAt(2*Math.PI),{x:1,y:0,z:0},5);
    expect(sol.notice).toBeUndefined();
    for(const p of sol.samples)expect(Math.hypot(p.x,p.y,p.z!)).toBeCloseTo(1,6);
  });
  it('点源最小距离在三维中触发停止，并禁止截止后的查询',()=>{
    const sc=scene(),g=makeField('point_mass',{x:0,y:0},{kind:'global'});
    g.sourceStrength=1/6.67430e-11;g.cutoffRadius=.1;sc.fields=[g];sc.bodies[0].charge=0;
    sc.bodies[0].pos={x:0,y:0,z:1};sc.bodies[0].vel={x:0,y:0,z:-1};
    sc.asks=[makeAsk('at_time',{t:4})];
    const sol=ok(solve(sc));expect(sol.events[0]?.kind).toBe('source_cutoff');expect(sol.evalAt(sol.tEnd).z).toBeCloseTo(.1,7);expect(sol.tEnd).toBeLessThan(1);
    expect(answer(sol,sc.asks[0].id).value).toBeNull();
  });
  it.each(['null-z','null-vz','finite-field','rod','two-balls','gradient-magnet'] as const)('拒绝未支持或不完整的条件：%s',kind=>{
    const sc=scene();
    if(kind==='null-z')sc.bodies[0].pos.z=null;
    if(kind==='null-vz')sc.bodies[0].vel.z=null;
    if(kind==='finite-field')sc.fields![0].shape={kind:'circle',center:{x:0,y:0},radius:2};
    if(kind==='rod')sc.links=[makeLink('rod',{x:0,y:0},sc.bodies[0].id,2)];
    if(kind==='two-balls')sc.bodies.push(makeBall({x:5,y:0}));
    if(kind==='gradient-magnet')sc.fields![0].gradient={x:1,y:0};
    expect(solve(sc).ok).toBe(false);
  });
  it.each(SPATIAL_EXAMPLES)('示例 $title 可以由对象和属性独立搭建',example=>{
    const manual=scene();
    if(example.id==='spatial-tilted'){manual.fields![0].bx=1;manual.fields![0].by=1;}
    if(example.id==='spatial-electric'){manual.fields![0].kind='uniform_electric';manual.fields![0].vector={x:0,y:0,z:2};}
    const reference=ok(solve(example.build())),rebuilt=ok(solve(manual));
    for(const t of [0,.4,1,2]){
      const a=reference.evalAt(t),b=rebuilt.evalAt(t);
      close3(b,{x:a.x,y:a.y,z:a.z!});expect(b.vz).toBeCloseTo(a.vz!);
    }
  });
});

describe('三维编辑、视图与兼容',()=>{
  it('从旧场景开启三维会补齐新增轴，保留未知量；撤销恢复原场景',()=>{
    const sc=scene();delete sc.dimension;delete sc.bodies[0].pos.z;sc.bodies[0].vel.z=null;
    const converted=withDimension(sc,'3d');
    expect(converted.bodies[0].pos.z).toBe(0);expect(converted.bodies[0].vel.z).toBeNull();
    let store=initStore(sc);store=reducer(store,{type:'apply',scene:converted});store=reducer(store,{type:'undo'});
    expect(store.present).toBe(sc);
  });
  it('三维数值在导入导出中保留，回到二维不会静默忽略非零 z',()=>{
    const sc=JSON.parse(JSON.stringify(spatialExample('tilted')));
    expect(isScene(sc)).toBe(true);expect(ok(solve(sc)).template).toBe('field-3d');
    expect(solve(withDimension(sc,'2d')).ok).toBe(false);
  });
  it('z、vz 及 Bx 支持参数绑定与单字段编辑',()=>{
    let sc=scene();sc.params=[{name:'p',value:2,unit:'none',min:-10,max:10,step:.1}];
    sc=withBinding(sc,'bodies.'+sc.bodies[0].id+'.vel.z','p');sc=withField(sc,'params.p.value',4);
    expect(resolveBindings(sc).bodies[0].vel.z).toBe(4);expect(ok(solve(sc)).evalAt(1).z).toBe(4);
  });
  it('空的 Ez 不会在切换维度时被误设为零',()=>{
    let sc=spatialExample('electric');sc=withField(sc,'fields.'+sc.fields![0].id+'.vector.z',null);
    sc=withDimension(sc,'3d');expect(sc.fields![0].vector.z).toBeNull();expect(solve(sc).ok).toBe(false);
    expect(solve(withDimension(sc,'2d')).ok).toBe(false);
  });
  it.each([{yaw:-35,pitch:-25},{yaw:0,pitch:0},{yaw:70,pitch:-65}])('固定 z 的拖动投影可逆：%j',rotation=>{
    const point={x:2.5,y:-3,z:4},projected=projectSpace(point,rotation),inverse=unprojectSpace(projected,point.z,rotation);
    close3(inverse,point,10);
  });
  it('旋转镜头不改变场景、播放和求解状态；轨迹适配保留旋转',()=>{
    let store=initStore(scene());const before=store;
    store=reducer(store,{type:'camera',camera:{...store.camera,rotation:{yaw:30,pitch:20}}});
    expect(store.present).toBe(before.present);expect(store.playback).toBe(before.playback);expect(store.formal).toBe(before.formal);
    const sol=ok(solve(store.present)),camera=fitPlaybackCamera(store.camera,sol.samples.map(p=>projectSpace(p,store.camera.rotation)),defaultLayout(1280,720),1280,720);
    expect(camera.rotation).toEqual({yaw:30,pitch:20});
  });
  it('三维轨迹与播放球使用同一求解状态和投影，不只绘制二维圆',()=>{
    let store=initStore(scene());const sol=ok(solve(store.present)),t=1;
    store=reducer(store,{type:'scrub',t});
    const markup=renderToStaticMarkup(createElement(SpatialCanvas,{store,dispatch(){},solution:sol,edit:{begin(){},end(){},transient(){},apply(){}}}));
    const projected=projectSpace(sol.evalAt(t)),x=store.camera.ox+projected.x*store.camera.scale,y=store.camera.oy-projected.y*store.camera.scale;
    expect(markup).toContain('data-axis="z"');expect(markup).toContain('spatial-trajectory');expect(markup).toContain('cx="'+x+'" cy="'+y+'"');
  });
});
