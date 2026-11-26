import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { baseScene, COLLISION_EXAMPLES, ELECTROMAGNETIC_EXAMPLES, EXAMPLES, makeAsk, makeBall, makeBlock, makeContact, makeField, makeLink, makeSupport } from '../src/model/factory';
import { DEFAULT_FIELD_PLAYBACK } from '../src/model/fields';
import type { FieldShape, Scene } from '../src/model/types';
import { initStore } from '../src/state/store';
import { Properties } from '../src/ui/Properties';
import { solve } from '../src/solver';
import { ok } from './helpers';

// Independent recipes use only objects exposed by the toolbar and values editable in Properties.
// They never call the example builders, import their JSON, or use old projectile/circular body types.
function rebuild(id:string):Scene {
  const sc=baseScene();
  const ball=(x:number,y:number,vx=0,vy=0,q=0)=>{
    const b=makeBall({x,y},q,vx,vy);sc.bodies.push(b);return b;
  };
  const rect=(x:number,y:number,width:number,height:number):FieldShape=>({kind:'rect',center:{x,y},width,height});
  const setExit=()=>{sc.fieldPlayback={...DEFAULT_FIELD_PLAYBACK,exit:'union'};};
  if(id==='incline'||id==='kinematics'){
    const incline=id==='incline';
    const surface=makeSupport('incline',{x:0,y:0},incline?5:40,incline?30:0);
    const b=makeBlock(surface.id,incline?5:0);
    sc.supports=[surface];sc.bodies=[b];
    sc.contacts=[makeContact(b.id,surface.id,incline?0.4:null,incline?0.3:null)];
    if(incline) sc.asks=[makeAsk('end_of_support'),makeAsk('friction_state')];
    else {b.vel.x=2;b.accel=3;sc.asks=[makeAsk('at_time',{t:4}),makeAsk('at_position',{x:30})];}
  } else if(['projectile','flat','projectile-incline','ball-throw'].includes(id)){
    const flat=id==='flat',slope=id==='projectile-incline';
    ball(0,flat?20:slope?15:2,flat||slope?10:6,flat||slope?0:8);
    const g=makeField('uniform_gravity',{x:2,y:3},{kind:'global'});
    g.vector.y=slope?-10:-9.8;sc.fields=[g];
    if(slope){sc.supports=[makeSupport('incline',{x:0,y:0},30,30)];sc.asks=[makeAsk('at_time',{t:1})];}
    else if(flat)sc.asks=[makeAsk('landing'),makeAsk('at_time',{t:1})];
    else sc.asks=[makeAsk('landing'),makeAsk('apex'),...(id==='projectile'?[makeAsk('at_height',{y:5})]:[])];
  } else if(id==='circular'){
    const b=ball(5,0,0,5);b.mass=2;
    sc.links=[makeLink('rod',{x:0,y:0},b.id,5)];
    sc.fieldPlayback={...DEFAULT_FIELD_PLAYBACK,duration:2*Math.PI};
    sc.asks=[makeAsk('at_time',{t:1})];
  } else if(id==='gravity-orbit'){
    ball(6,4,0,2);
    const f=makeField('point_mass',{x:4,y:4});f.sourceStrength=8/6.67430e-11;sc.fields=[f];
    sc.fieldPlayback={...DEFAULT_FIELD_PLAYBACK,duration:2*Math.PI};
    sc.asks=[makeAsk('at_time',{t:Math.PI/2})];
  } else if(['electric-field','magnetic-field','crossed-fields','point-field'].includes(id)){
    ball(1,3,3,0,id==='point-field'?-1:1);
    const center={x:4,y:3};
    const shape:FieldShape=id==='point-field'?{kind:'circle',center,radius:3}:rect(4,3,8,6);
    if(id==='electric-field')sc.fields=[makeField('uniform_electric',center,shape)];
    if(id==='magnetic-field')sc.fields=[makeField('uniform_magnetic',center,shape)];
    if(id==='point-field')sc.fields=[makeField('point_charge',center,shape)];
    if(id==='crossed-fields'){
      const e=makeField('uniform_electric',center,shape);e.vector={x:0,y:3};
      sc.fields=[e,makeField('uniform_magnetic',center,shape)];
    }
    setExit();sc.asks=[makeAsk('field_exit')];
  } else if(id==='parallel-plate-acceleration'||id==='parallel-plate-deflection'){
    const accelerating=id==='parallel-plate-acceleration';
    const b=ball(0,accelerating?3:4,accelerating?0:4,0,1);b.mass=accelerating?2:1;
    const shape=accelerating?rect(3,3,6,4):rect(5,4,8,6);
    const f=makeField('uniform_electric',accelerating?{x:3,y:3}:{x:5,y:4},shape);
    f.plates={axis:accelerating?'x':'y',voltage:accelerating?12:-6};sc.fields=[f];
    setExit();sc.fieldPlayback!.afterExit=1;
    sc.asks=[...(!accelerating?[makeAsk('field_entry',{fieldId:f.id})]:[]),makeAsk('field_exit',{fieldId:f.id}),
      makeAsk('work_between',{energyFrom:{kind:'event',event:'initial'},energyTo:{kind:'event',event:'field_exit'}})];
  } else if(id==='magnetic-return'||id==='selector-to-magnet'){
    const selector=id==='selector-to-magnet';ball(0,8,3,0,1);
    const shape=selector?rect(7.5,5,5,10):rect(4.5,5,7,10);
    const magnet=makeField('uniform_magnetic',selector?{x:7.5,y:5}:{x:4.5,y:5},shape);
    sc.fields=[magnet];
    sc.asks=[makeAsk('field_entry',{fieldId:magnet.id}),makeAsk('field_exit',{fieldId:magnet.id})];
    if(selector){
      const e=makeField('uniform_electric',{x:3,y:7},rect(3,7,4,6));e.vector={x:0,y:3};
      sc.fields.unshift(e,makeField('uniform_magnetic',{x:3,y:7},rect(3,7,4,6)));
      sc.asks.unshift(makeAsk('field_exit',{fieldId:e.id}));
    }
    setExit();sc.fieldPlayback!.afterExit=0.5;
  } else if(id==='gradient-magnet'){
    ball(4,4,3,0,1);
    const f=makeField('uniform_magnetic',{x:4,y:4},{kind:'global'});f.gradient={x:0.25,y:0};sc.fields=[f];
    sc.fieldPlayback={...DEFAULT_FIELD_PLAYBACK,duration:8};sc.asks=[makeAsk('at_time',{t:1})];
  } else if(id.startsWith('collision-')){
    const a=ball(0,3,id==='collision-chase'?4:3),b=ball(6,id==='collision-oblique'?3.6:3,id==='collision-elastic'?-1:id==='collision-chase'?1:0);
    a.collisionRadius=b.collisionRadius=0.5;
    if(id==='collision-inelastic'||id==='collision-chase')b.mass=2;
    sc.collision={restitution:id==='collision-inelastic'?0:id==='collision-chase'?0.5:1,afterCollision:3};
    sc.asks=[makeAsk('collision'),makeAsk('at_time',{t:3})];
  } else throw Error('Missing manual recipe: '+id);
  return sc;
}

describe('所有菜单示例均可从空场景手动搭建',()=>{
  it.each([...EXAMPLES,...ELECTROMAGNETIC_EXAMPLES,...COLLISION_EXAMPLES])('$title：独立搭建后的答案和运动一致',example=>{
    const expectedScene=example.build(),manual=rebuild(example.id);
    for(const scene of [expectedScene,manual]){
      expect(scene.bodies.every(b=>b.kind==='ball'||b.kind==='block')).toBe(true);
      for(const id of [...scene.bodies,...(scene.fields??[]),...(scene.links??[])].map(object=>object.id)){
        const markup=renderToStaticMarkup(createElement(Properties,{store:{...initStore(scene),selection:id},dispatch(){},fields:{commit(){},transient(){}}}));
        expect(markup).toContain('panel-content');
      }
    }
    const expected=ok(solve(expectedScene)),actual=ok(solve(manual));
    expect(actual.template).toBe(expected.template);
    expect(actual.tEnd).toBeCloseTo(expected.tEnd,7);
    for(const fraction of [0,0.25,0.5,0.9,1]){
      const a=actual.evalAt(actual.tEnd*fraction),b=expected.evalAt(expected.tEnd*fraction);
      for(const key of ['x','y','vx','vy'] as const)expect(a[key]).toBeCloseTo(b[key],6);
    }
    // Compare all answers in order, independently of generated object/ask IDs and display names.
    expect(actual.answers.length).toBe(expected.answers.length);
    actual.answers.forEach((answer,i)=>{
      const want=expected.answers[i];
      expect(answer.unit).toBe(want.unit);
      if(want.value===null)expect(answer.value).toBeNull();
      else expect(answer.value).toBeCloseTo(want.value,6);
    });
  });
});
