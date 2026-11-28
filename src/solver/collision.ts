import { DEFAULT_COLLISION } from '../model/factory';
import { isCharged } from '../model/fields';
import type { Answer, CheckIssue, EnergyPoint, EnergySample, Sample, Scene, Solution, Vec2 } from '../model/types';
import { issue, type Template } from './template';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const dot = (a: Vec2,b: Vec2) => a.x*b.x+a.y*b.y;
const sub = (a: Vec2,b: Vec2) => ({x:a.x-b.x,y:a.y-b.y});

/** Analytic first contact of two freely translating disks. Tangency without approach is not an impact. */
function contactTime(r: Vec2,v: Vec2,radius: number): number | null {
  const speed=Math.hypot(v.x,v.y),distance=Math.hypot(r.x,r.y);
  if(speed===0) return null;
  const direction={x:v.x/speed,y:v.y/speed};
  const along=dot(r,direction);
  if(along>=0) return null;
  const perpendicular=r.x*direction.y-r.y*direction.x;
  const chordSquared=(radius-Math.abs(perpendicular))*(radius+Math.abs(perpendicular));
  if(chordSquared<=0) return null;
  const chord=Math.sqrt(chordSquared);
  // Rationalized root avoids cancellation when initially almost touching.
  return Math.max(0,(distance-radius)*(distance+radius)/(-along+chord)/speed);
}

export const collisionTemplate: Template = {
  id:'collision',
  match:scene=>scene.bodies.length===2&&scene.bodies.every(b=>b.kind==='ball'),
  solve(scene: Scene){
    const bodies=scene.bodies;
    const settings=scene.collision??DEFAULT_COLLISION;
    // 共享契约允许 afterCollision/collisionRadius 为 null（播放与示意设置，非题面测量值），回退默认值。
    const afterCollision=settings.afterCollision??DEFAULT_COLLISION.afterCollision;
    const blockers: CheckIssue[]=[];
    const fail=(path:string,note:string)=>blockers.push(issue('constraint_conflict',path,note));
    if(scene.fields?.some(f=>f.enabled)||scene.links?.some(l=>l.bodyId!==null)||scene.supports.length||scene.contacts.length)
      blockers.push(issue('unsupported_combo','bodies','双球碰撞目前计算无外场、无支撑面、无绳杆的自由运动，忽略自转和切向摩擦。'));
    if(!finite(settings.restitution)||settings.restitution<0||settings.restitution>1) fail('collision.restitution','恢复系数 e 必须在 0 到 1 之间。');
    if(!finite(afterCollision)||afterCollision<0) fail('collision.afterCollision','碰后播放时长必须是非负有限数。');
    for(const b of bodies){
      const path='bodies.'+b.id;
      const quantities={mass:b.mass,'pos.x':b.pos.x,'pos.y':b.pos.y,'vel.x':b.vel.x,'vel.y':b.vel.y,collisionRadius:b.collisionRadius??0.25};
      for(const [key,value] of Object.entries(quantities)) if(!finite(value)) blockers.push(issue('missing_required',path+'.'+key,'请填写有限数值。'));
      if(finite(b.mass)&&b.mass<=0) fail(path+'.mass','质量必须为正。');
      if(finite(quantities.collisionRadius)&&quantities.collisionRadius<=0) fail(path+'.collisionRadius','碰撞半径必须为正。');
      if(isCharged(b)&&bodies.filter(isCharged).length>1) fail(path+'.charge','两个带电小球之间的库仑力尚未纳入碰撞模型。');
      if(b.attach) fail(path+'.attach','碰撞小球不能依附于支撑面。');
    }
    if(bodies[0].id===bodies[1].id) fail('bodies','两个物体的 ID 不能相同。');
    if(blockers.length) return {ok:false,report:{blockers,pending:[]},flags:['conflict']};
    const p=bodies.map(b=>({x:b.pos.x!,y:b.pos.y!}));
    const u=bodies.map(b=>({x:b.vel.x!,y:b.vel.y!}));
    const m=bodies.map(b=>b.mass!);
    const r=sub(p[1],p[0]),rel=sub(u[1],u[0]);
    const radius=bodies.reduce((sum,b)=>sum+(b.collisionRadius??0.25),0);
    const distance=Math.hypot(r.x,r.y);
    if(distance<radius-32*Number.EPSILON*Math.max(distance,radius)){
      fail('bodies','两个小球初始重叠，请拉开到两球半径之和或更远。');
      return {ok:false,report:{blockers,pending:[]},flags:['conflict']};
    }
    const tc=contactTime(r,rel,radius);
    const impact=tc===null?null:p.map((a,i)=>({x:a.x+u[i].x*tc,y:a.y+u[i].y*tc}));
    const v=u.map(a=>({...a}));
    let impulse=0;
    if(tc!==null&&impact){
      const normal=sub(impact[1],impact[0]),length=Math.hypot(normal.x,normal.y);
      normal.x/=length;normal.y/=length;
      const approaching=-dot(rel,normal);
      impulse=(1+settings.restitution!)*approaching/(1/m[0]+1/m[1]);
      v[0]={x:u[0].x-impulse/m[0]*normal.x,y:u[0].y-impulse/m[0]*normal.y};
      v[1]={x:u[1].x+impulse/m[1]*normal.x,y:u[1].y+impulse/m[1]*normal.y};
    }
    const kinetic=(velocities: Vec2[])=>velocities.reduce((sum,a,i)=>sum+0.5*m[i]*dot(a,a),0);
    const beforeK=kinetic(u),afterK=kinetic(v),loss=Math.max(0,beforeK-afterK);
    const requested=scene.asks.flatMap(ask=>[ask.t,ask.energyFrom?.kind==='time'?ask.energyFrom.t:0,ask.energyTo?.kind==='time'?ask.energyTo.t:0])
      .filter((t):t is number=>finite(t)&&t>=0);
    const stationary=v.every(a=>a.x===0&&a.y===0);
    const tEnd=stationary?(tc??0):Math.max(tc===null?3:tc+afterCollision,...requested);
    const momentum=(velocities:Vec2[])=>velocities.reduce((total,a,i)=>({x:total.x+m[i]*a.x,y:total.y+m[i]*a.y}),{x:0,y:0});
    const pin=momentum(u),pout=momentum(v);
    if(![tEnd,tc??0,impulse,beforeK,afterK,pin.x,pin.y,pout.x,pout.y,...v.flatMap(a=>[a.x,a.y])].every(finite)){
      fail('bodies','参数超出可计算范围，请调整数值。');
      return {ok:false,report:{blockers,pending:[]},flags:['conflict']};
    }
    const at=(i:number,time:number,before=false):Sample=>{
      const t=Math.max(0,time),after=tc!==null&&t>=tc&&!before,vel=after?v[i]:u[i];
      const x=after?impact![i].x+vel.x*(t-tc!):p[i].x+vel.x*t;
      const y=after?impact![i].y+vel.y*(t-tc!):p[i].y+vel.y*t;
      return {t,x,y,vx:vel.x,vy:vel.y,s:x-p[i].x};
    };
    if(bodies.some((_,i)=>![at(i,tEnd).x,at(i,tEnd).y].every(finite))){
      fail('bodies','位置超出可计算范围，请缩短播放时长或调整速度。');
      return {ok:false,report:{blockers,pending:[]},flags:['conflict']};
    }
    const times=[...new Set([0,tEnd,...Array.from({length:200},(_,i)=>tEnd*i/200),...(tc!==null?[tc]:[])])].sort((a,b)=>a-b);
    const bodyTracks=bodies.map((body,i)=>({bodyId:body.id,name:body.name,
      evalAt:(time:number)=>at(i,Math.min(tEnd,Math.max(0,time))),
      samples:times.flatMap(time=>tc!==null&&time===tc?[at(i,time,true),at(i,time)]:[at(i,time)]),
    }));
    const energyAt=(t:number,before=false):EnergySample|null=>{
      if(!finite(t)||t<0) return null;
      const collided=tc!==null&&t>=tc&&!before;
      return {t,kinetic:collided?afterK:beforeK,potential:0,mechanical:collided?afterK:beforeK,dissipated:collided?loss:0};
    };
    const energy: NonNullable<Solution['energy']>={status:'ready',
      samples:times.flatMap(t=>tc!==null&&t===tc?[energyAt(t,true)!,energyAt(t)!]:[energyAt(t)!]),evalAt:energyAt,
      note:'显示两球系统总动能和碰撞耗散；碰撞瞬间取碰后值。',
      workBetween(from,to){
        const a=energyAt(from),b=energyAt(to);
        if(!a||!b||to<from) return null;
        const kineticChange=b.kinetic-a.kinetic,dissipated=b.dissipated!-a.dissipated!;
        return {gravity:0,friction:0,net:kineticChange,dissipated,kineticChange,mechanicalChange:kineticChange,balance:'verified'};
      },
    };
    const answers:Answer[]=[];
    const out=(id:string,label:string,value:number|null,unit:string,note?:string)=>answers.push({id,label,value,unit,note});
    out('collision_t','首次碰撞时刻',tc,'s',tc===null?'按相对运动解析判断：两球不会发生产生冲量的碰撞。':undefined);
    bodies.forEach((body,i)=>{
      for(const [key,label,vel] of [['before','碰前',u[i]],['after','碰后',v[i]]] as const){
        out(body.id+'.'+key+'.vx',body.name+' · '+label+' vx',tc===null?null:vel.x,'m/s');
        out(body.id+'.'+key+'.vy',body.name+' · '+label+' vy',tc===null?null:vel.y,'m/s');
      }
    });
    out('impulse','两球所受冲量大小',tc===null?null:impulse,'N·s');
    out('momentum_before.x','碰前系统动量 px',tc===null?null:pin.x,'kg·m/s');
    out('momentum_before.y','碰前系统动量 py',tc===null?null:pin.y,'kg·m/s');
    out('momentum_after.x','碰后系统动量 px',tc===null?null:pout.x,'kg·m/s');
    out('momentum_after.y','碰后系统动量 py',tc===null?null:pout.y,'kg·m/s');
    out('kinetic_before','碰前总动能',tc===null?null:beforeK,'J');
    out('kinetic_after','碰后总动能',tc===null?null:afterK,'J');
    out('collision_loss','碰撞损失的动能',tc===null?null:loss,'J');
    const resolve=(point?:EnergyPoint)=>point?.kind==='time'?point.t:point?.kind==='event'?(point.event==='initial'?0:point.event==='collision'?tc:point.event==='final_rest'&&stationary?(tc??0):null):null;
    for(const ask of scene.asks){
      if(ask.kind==='collision') continue;
      if(ask.kind==='at_time'&&finite(ask.t)&&ask.t>=0){
        bodies.forEach((body,i)=>{
          const s=at(i,ask.t!);
          for(const [key,unit] of [['x','m'],['y','m'],['vx','m/s'],['vy','m/s']] as const)
            out(ask.id+'.'+body.id+'.'+key,body.name+' · t='+ask.t+' s · '+key,s[key],unit);
        });
      } else if(ask.kind==='energy_at'){
        const t=resolve(ask.energyFrom),e=t===null?null:energyAt(t);
        if(e){out(ask.id+'.kinetic','系统总动能',e.kinetic,'J');out(ask.id+'.dissipated','碰撞耗散',e.dissipated,'J');}
        else out(ask.id,'系统能量',null,'J','查询时刻或事件不可用。');
      } else if(ask.kind==='work_between'){
        const a=resolve(ask.energyFrom),b=resolve(ask.energyTo),work=a===null||b===null?null:energy.workBetween(a,b);
        if(work){out(ask.id+'.net','系统合功（包含碰撞内力的功）',work.net,'J');out(ask.id+'.dissipated','区间碰撞耗散',work.dissipated,'J');}
        else out(ask.id,'区间做功',null,'J','请选择有效且顺序正确的时刻或事件。');
      } else out(ask.id,'此碰撞场景的待求量',null,'','支持碰撞状态、指定时刻和系统能量查询。');
    }
    return {ok:true,solution:{template:'collision',sceneRev:scene.rev,tEnd,bodyTracks,
      evalAt:bodyTracks[0].evalAt,samples:bodyTracks[0].samples,energy,answers,flags:[],
      stages:tc===null?[{label:stationary?'两球静止':'不会相撞',t0:0,t1:tEnd}]:[
        ...(tc>0?[{label:'碰前运动',t0:0,t1:tc}]:[]),{label:stationary?'碰后静止':'碰后运动',t0:tc,t1:tEnd}],
      events:tc===null?[]:[{kind:'collision',t:tc,label:'两球碰撞'}],
      steps:[
        {title:'由相对运动求首次接触',formula:'\\left|\\vec r_2-\\vec r_1+(\\vec u_2-\\vec u_1)t_c\\right|=R_1+R_2',note:'取靠近时的第一个非负根，擦边且无冲量不算碰撞。'},
        {title:'沿接触法线计算冲量',formula:'J=-\\frac{(1+e)(\\vec u_2-\\vec u_1)\\cdot\\vec n}{1/m_1+1/m_2}',note:'e=1 为弹性，0<e<1 为非弹性；e=0 的正碰共速，斜碰仍保留相对切向速度。'},
        {title:'两球速度与动量守恒',formula:'\\vec v_1=\\vec u_1-\\frac{J}{m_1}\\vec n,\\quad\\vec v_2=\\vec u_2+\\frac{J}{m_2}\\vec n,\\quad\\sum m_i\\vec u_i=\\sum m_i\\vec v_i'},
        {title:'计算动能损失',formula:'\\Delta E_k=\\frac12\\frac{m_1m_2}{m_1+m_2}(1-e^2)\\left[(\\vec u_2-\\vec u_1)\\cdot\\vec n\\right]^2'},
      ],formulas:[{label:'恢复系数',latex:'e=-\\frac{(\\vec v_2-\\vec v_1)\\cdot\\vec n}{(\\vec u_2-\\vec u_1)\\cdot\\vec n}'}],
    }};
  },
};
