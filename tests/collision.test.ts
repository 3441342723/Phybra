import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { baseScene, COLLISION_EXAMPLES, collisionExample, makeAsk, makeBall, makeField } from '../src/model/factory';
import { isScene } from '../src/state/persist';
import { initStore, reducer } from '../src/state/store';
import { withField } from '../src/state/editing';
import { solve } from '../src/solver';
import { Canvas } from '../src/ui/Canvas';
import { Properties } from '../src/ui/Properties';
import { ObjectList } from '../src/ui/ObjectList';
import { answer, ok } from './helpers';

describe('双球光滑碰撞',()=>{
  it('等质量弹性对碰交换速度，动量和动能守恒',()=>{
    const sc=collisionExample('elastic'),sol=ok(solve(sc)),[a,b]=sc.bodies;
    expect(answer(sol,'collision_t').value).toBe(1.25);
    expect(answer(sol,a.id+'.after.vx').value).toBe(-1);
    expect(answer(sol,b.id+'.after.vx').value).toBe(3);
    expect(answer(sol,'kinetic_before').value).toBe(5);
    expect(answer(sol,'kinetic_after').value).toBe(5);
    expect(answer(sol,'momentum_before.x').value).toBe(answer(sol,'momentum_after.x').value);
    const [pa,pb]=sol.bodyTracks!.map(track=>track.evalAt(1.25));
    expect(pb.x-pa.x).toBe(1);
  });

  it('afterCollision 与 collisionRadius 为 null 时回退默认值，碰后速度不变（DEF-013）',()=>{
    const base=collisionExample('elastic');
    base.collision!.afterCollision=3;
    for(const b of base.bodies)b.collisionRadius=0.25;
    const sc=collisionExample('elastic');
    sc.collision!.afterCollision=null;
    for(const b of sc.bodies)b.collisionRadius=null;
    const sol=ok(solve(sc)),ref=ok(solve(base));
    expect(answer(sol,sc.bodies[0].id+'.after.vx').value).toBeCloseTo(answer(ref,base.bodies[0].id+'.after.vx').value!);
    expect(answer(sol,sc.bodies[1].id+'.after.vx').value).toBeCloseTo(answer(ref,base.bodies[1].id+'.after.vx').value!);
    for(const id of ['collision_t','kinetic_after'])
      expect(answer(sol,id).value).toBeCloseTo(answer(ref,id).value!);
  });

  it('完全非弹性正碰共速，动能损失按约化质量计算',()=>{
    const sc=collisionExample('inelastic'),sol=ok(solve(sc));
    expect(answer(sol,'collision_t').value).toBeCloseTo(5/3);
    for(const body of sc.bodies) expect(answer(sol,body.id+'.after.vx').value).toBe(1);
    expect(answer(sol,'collision_loss').value).toBe(3);
    const [a,b]=sol.bodyTracks!.map(track=>track.evalAt(sol.tEnd));
    expect(b.x-a.x).toBeCloseTo(1);
  });

  it('不等质量追碰，恢复系数等于分离速率与接近速率之比',()=>{
    const sc=collisionExample('chase'),sol=ok(solve(sc));
    const a=answer(sol,sc.bodies[0].id+'.after.vx').value!;
    const b=answer(sol,sc.bodies[1].id+'.after.vx').value!;
    expect(a).toBe(1); expect(b).toBe(2.5);
    expect((b-a)/3).toBe(0.5);
    expect(answer(sol,'collision_loss').value).toBeCloseTo(2.25);
  });

  it('二维斜碰只改变法向速度，保持切向速度与矢量动量',()=>{
    const sc=collisionExample('oblique'),sol=ok(solve(sc)),tc=answer(sol,'collision_t').value!;
    expect(tc).toBeCloseTo((6-0.8)/3);
    const [a,b]=sol.bodyTracks!.map(track=>track.evalAt(tc));
    expect(a.vx).toBeCloseTo(1.08);
    expect(a.vy).toBeCloseTo(-1.44);
    expect(b.vx).toBeCloseTo(1.92);
    expect(b.vy).toBeCloseTo(1.44);
    expect(answer(sol,'collision_loss').value).toBeCloseTo(0);
    expect(answer(sol,'momentum_after.x').value).toBeCloseTo(3);
    expect(answer(sol,'momentum_after.y').value).toBeCloseTo(0);
  });

  it.each(['分离','同速','擦边','错开'] as const)('%s 轨迹解析判定不会相撞',kind=>{
    const sc=collisionExample('elastic');
    if(kind==='分离') sc.bodies[0].vel.x=-3;
    if(kind==='同速') sc.bodies[1].vel.x=3;
    if(kind==='擦边') sc.bodies[1].pos.y=4;
    if(kind==='错开') sc.bodies[1].pos.y=5;
    const sol=ok(solve(sc));
    expect(answer(sol,'collision_t').value).toBeNull();
    expect(sol.events).toHaveLength(0);
    expect(sol.bodyTracks![0].evalAt(2).vx).toBe(sc.bodies[0].vel.x);
  });

  it('碰撞在 40 秒后仍求出真实时间，高速碰撞不因步进而穿透',()=>{
    const sc=collisionExample('elastic');
    sc.bodies[1].pos.x=82; sc.bodies[0].vel.x=1;sc.bodies[1].vel.x=-1;
    expect(answer(ok(solve(sc)),'collision_t').value).toBe(40.5);
    sc.bodies[0].vel.x=1e8;sc.bodies[1].vel.x=-1e8;
    const sol=ok(solve(sc));
    expect(answer(sol,'collision_t').value).toBeCloseTo(81/2e8,14);
    expect(sol.bodyTracks![0].evalAt(1).vx).toBe(-1e8);
  });

  it('初始接触只在靠近时发生碰撞，重叠被拒绝',()=>{
    const sc=collisionExample('elastic');sc.bodies[1].pos.x=1;
    expect(answer(ok(solve(sc)),'collision_t').value).toBe(0);
    sc.bodies[0].vel.x=-3;sc.bodies[1].vel.x=1;
    expect(answer(ok(solve(sc)),'collision_t').value).toBeNull();
    sc.bodies[1].pos.x=0.5;
    expect(solve(sc)).toMatchObject({ok:false});
  });

  it('两球静止或完全非弹性等量反向碰后静止时立即停止播放',()=>{
    const sc=collisionExample('elastic');sc.bodies.forEach(b=>b.vel.x=0);
    expect(ok(solve(sc)).tEnd).toBe(0);
    sc.bodies[0].vel.x=3;sc.bodies[1].vel.x=-3;sc.collision!.restitution=0;
    const sol=ok(solve(sc));expect(sol.tEnd).toBe(answer(sol,'collision_t').value);
  });

  it('能量曲线保留碰前碰后的跳变，查询事件和区间耗散一致',()=>{
    const sc=collisionExample('inelastic');
    const energy=makeAsk('energy_at',{energyFrom:{kind:'event',event:'collision'}});
    const work=makeAsk('work_between',{energyFrom:{kind:'event',event:'initial'},energyTo:{kind:'event',event:'collision'}});
    sc.asks.push(energy,work);
    const sol=ok(solve(sc)),tc=answer(sol,'collision_t').value!;
    expect(answer(sol,energy.id+'.kinetic').value).toBe(1.5);
    expect(answer(sol,work.id+'.net').value).toBe(-3);
    expect(answer(sol,work.id+'.dissipated').value).toBe(3);
    expect(sol.energy?.status).toBe('ready');
    if(sol.energy?.status==='ready') expect(sol.energy.samples.filter(s=>s.t===tc).map(s=>s.kinetic)).toEqual([4.5,1.5]);
    expect(sol.bodyTracks![0].samples.filter(s=>s.t===tc).map(s=>s.vx)).toEqual([3,1]);
  });

  it.each([null,-1,1.1,Infinity])('非法恢复系数 %s 不会悄悄使用默认值',e=>{
    const sc=collisionExample('elastic');sc.collision!.restitution=e;
    expect(solve(sc)).toMatchObject({ok:false});
  });

  it('不支持的外场、带电和多球组合有明确提示',()=>{
    const sc=collisionExample('elastic');
    sc.fields=[makeField('uniform_gravity',{x:0,y:0})];
    expect(solve(sc)).toMatchObject({ok:false});
    sc.fields=[];sc.bodies[0].charged=true;sc.bodies[0].charge=1;
    expect(solve(sc)).toMatchObject({ok:true});
    sc.bodies[1].charged=true;sc.bodies[1].charge=1;
    expect(solve(sc)).toMatchObject({ok:false});
    sc.bodies.push(makeBall({x:20,y:3}));
    expect(solve(sc)).toMatchObject({ok:false});
  });

  it('从空场景放置两个小球即可求解，参数绑定、保存恢复和撤销有效',()=>{
    const manual=baseScene();
    manual.bodies=[makeBall({x:0,y:3},0,3),makeBall({x:6,y:3},0,-1)];
    manual.collision={restitution:1,afterCollision:3};
    manual.params=[{name:'e',value:0,unit:'none',min:0,max:1,step:0.1}];
    manual.bindings={'collision.restitution':'e'};
    const copy=JSON.parse(JSON.stringify(manual));expect(isScene(copy)).toBe(true);
    const sol=ok(solve(copy));expect(answer(sol,manual.bodies[0].id+'.after.vx').value).toBe(1);
    const store=initStore(copy),next=reducer(store,{type:'apply',scene:withField(copy,'collision.restitution',0.5)});
    expect(reducer(next,{type:'undo'}).present).toEqual(copy);
    expect(answer(ok(solve(next.present)),manual.bodies[0].id+'.after.vx').value).toBe(0);
  });

  it.each(COLLISION_EXAMPLES)('$title 同时渲染两球且重置不改初始条件',({build})=>{
    const scene=build(),sol=ok(solve(scene));
    const store=initStore(scene),played=reducer(store,{type:'scrub',t:sol.tEnd/2});
    const render=(state:typeof store)=>renderToStaticMarkup(createElement(Canvas,{store:state,solution:sol,dispatch(){},edit:{begin(){},end(){},apply(){},transient(){}}}));
    const markup=render(played);
    for(const track of sol.bodyTracks!){
      expect(markup).toContain('data-moving-body="'+track.bodyId+'"');
      const expected=track.evalAt(played.playback.t);
      expect(markup).toContain('cx="'+(store.camera.ox+expected.x*store.camera.scale)+'"');
    }
    expect(render(reducer(played,{type:'resetPlayback'}))).toBe(render(store));
    const props=renderToStaticMarkup(createElement(Properties,{store:{...store,selection:scene.bodies[0].id},dispatch(){},fields:{commit(){},transient(){}}}));
    expect(props).toContain('恢复系数');expect(props).toContain('碰撞半径');
    const objects=renderToStaticMarkup(createElement(ObjectList,{store,solution:sol,dispatch(){},fields:{commit(){},transient(){}}}));
    expect(objects).toContain('碰撞时刻与碰前碰后状态');
  });
});
