import { contains, DEFAULT_FIELD_PLAYBACK, electricVector, hasGradient, isCharged, isPointSource, validPolygon } from '../model/fields';
import type { Answer, EnergyAnalysis, EnergyPoint, Field, FieldShape, Scene, Solution, Vec2 } from '../model/types';
import { fmt } from '../model/units';
import { acceleration, firstCrossing, near, point, rkFlow, segmentStep, sumFields, uniformFlow, type Boundary, type Segment, type State } from './fieldMotion';
import { projectileTemplate } from './projectile';
import { issue, type Template } from './template';

const MAX_STEPS = 16000;
const MAX_EVENTS = 256;
const FORMULA = '\\vec a=\\sum\\vec g+\\frac qm(\\sum\\vec E+\\vec v\\times\\sum\\vec B)';
const WARNING = '达到数值计算保护上限，后续运动尚未确定。';
const norm = (x: number, y: number) => Math.hypot(x,y);
const finite = (n: unknown): n is number => typeof n==='number' && Number.isFinite(n);
const validPoint = (p: Vec2) => p && finite(p.x) && finite(p.y);
const positive = (v: unknown) => finite(v) && v>0;
const dot = (a: Vec2,b: Vec2)=>a.x*b.x+a.y*b.y;

function validShape(shape: FieldShape): boolean {
  if (!shape) return false;
  switch(shape.kind) {
    case 'global': return true;
    case 'rect': return validPoint(shape.center) && positive(shape.width) && positive(shape.height);
    case 'circle': return validPoint(shape.center) && positive(shape.radius);
    case 'polygon': return Array.isArray(shape.vertices) && validPolygon(shape.vertices);
    default: return false;
  }
}

export const fieldTemplate: Template = {
  id: 'field',
  match: (scene) => scene.bodies.length===1 && scene.bodies[0].kind==='ball',
  solve(scene: Scene) {
    const b=scene.bodies[0];
    const path='bodies.'+b.id;
    const enabled=(scene.fields ?? []).filter((f)=>f.enabled);
    const links=scene.links ?? [];
    const link=links.find(l=>l.bodyId===b.id);
    const settings={...DEFAULT_FIELD_PLAYBACK,...scene.fieldPlayback};
    const charged=isCharged(b);
    const charge=charged ? b.charge : 0;
    const blockers=[];
    const fail=(p: string,note: string)=>issue('constraint_conflict',p,note);
    for(const [name,v] of Object.entries({mass:b.mass,charge,'pos.x':b.pos.x,'pos.y':b.pos.y,'vel.x':b.vel.x,'vel.y':b.vel.y})) {
      if(!finite(v)) blockers.push(issue('missing_required',path+'.'+name,'请填写有限数值。'));
    }
    if(charged&&charge===0) blockers.push(fail(path+'.charge','已勾选带电，请填写非零电荷量；中性小球可取消勾选。'));
    if(finite(b.mass)&&b.mass<=0) blockers.push(fail(path+'.mass','质量必须为正。'));
    if(!positive(settings.duration)) blockers.push(fail('fieldPlayback.duration','求解时长必须大于 0。'));
    if(!finite(settings.afterExit)||settings.afterExit<0) blockers.push(fail('fieldPlayback.afterExit','续播时长不能为负。'));
    const finiteFields=enabled.filter(f=>f.shape?.kind!=='global');
    if(settings.exit==='field'&&!finiteFields.some(f=>f.id===settings.fieldId)) blockers.push(fail('fieldPlayback.fieldId','请选择一个已启用且有边界的场区。'));
    if(settings.exit==='union'&&!finiteFields.length) blockers.push(fail('fieldPlayback.exit','并集出场需要至少一个已启用的有限场区。'));
    if(!['field','union','continue'].includes(settings.exit)) blockers.push(fail('fieldPlayback.exit','无法识别出场方式。'));
    if(new Set(enabled.map(f=>f.id)).size!==enabled.length) blockers.push(fail('fields','场对象 ID 重复。'));
    for(const f of enabled) {
      const p='fields.'+f.id;
      if(!validShape(f.shape)) blockers.push(fail(p+'.shape','边界尺寸必须为正；多边形至少三个顶点，且不能自交。'));
      if(!validPoint(f.position)) blockers.push(fail(p+'.position','请填写有效的场源位置。'));
      if(hasGradient(f)&&(!finite(f.gradient!.x)||!finite(f.gradient!.y))) blockers.push(fail(p+'.gradient','请填写两个方向的场强变化量，不变化的方向填 0。'));
      if(hasGradient(f)&&f.kind==='uniform_electric'&&f.plates) blockers.push(fail(p+'.gradient','线性渐变与平行板模式不能同时启用。'));
      if(f.kind==='uniform_electric'&&f.plates) {
        if(!electricVector(f)) blockers.push(fail(p+'.plates','平行板需要矩形场区、正的板间距和有效电压。'));
      } else if(f.kind==='uniform_electric'||f.kind==='uniform_gravity') {
        if(!validPoint(f.vector)) blockers.push(fail(p+'.vector','请填写有效的场强分量。'));
      } else if (f.kind==='uniform_magnetic') {
        if(!finite(f.bz)) blockers.push(fail(p+'.bz','请填写有效的磁感应强度。'));
      } else if (isPointSource(f)) {
        if(!positive(f.cutoffRadius)||!finite(f.sourceStrength)||(f.kind==='point_mass'&&f.sourceStrength<=0)) blockers.push(fail(p,'请填写有效源强和正的最小距离。'));
      } else blockers.push(fail(p,'未知场类型。'));
    }
    if(links.filter(l=>l.bodyId!==null).length>1) blockers.push(fail('links','一个小球仅支持一根定点绳或杆。'));
    if(link&&(!positive(link.length)||!validPoint(link.anchor))) blockers.push(fail('links.'+link.id,'绳杆需要有效锚点和正长度。'));
    if(blockers.length) return { ok:false, report:{blockers,pending:[]},flags:['conflict'] };

    const fields=enabled.map(f=>f.kind==='uniform_electric'&&f.plates?{...f,vector:electricVector(f)!}:f);
    const m=b.mass!, q=charge!, qm=q/m;
    const s0: State=[b.pos.x!,b.pos.y!,b.vel.x!,b.vel.y!,0,0];
    const analyticGravity=fields.length>0 && fields.every(f=>f.kind==='uniform_gravity'&&!hasGradient(f)&&f.shape.kind==='global'&&f.vector.x===0)
      && fields.reduce((g,f)=>g+f.vector.y,0)<0;
    // Use the existing closed-form projectile/ground solver when the chosen objects imply that model.
    if(!link&&analyticGravity&&s0[1]>=0&&!(s0[1]===0&&s0[3]<0)&&!scene.asks.some(a=>a.kind==='field_exit'||a.kind==='field_entry')) {
      const gravity=-fields.reduce((g,f)=>g+f.vector.y,0);
      const result=projectileTemplate.solve({...scene,gravity,bodies:[{...b,kind:'projectile'}]});
      if(result.ok) {
        const sol=result.solution, evalAt=sol.evalAt;
        sol.evalAt=(t)=>({...evalAt(t),ax:0,ay:-gravity});
        sol.samples=sol.samples.map(s=>({...s,ax:0,ay:-gravity}));
        sol.steps.unshift({title:'由小球与重力场识别抛体运动',formula:'a_x=0,\\quad a_y=\\sum g_y',note:'此标准抛体模型以 y=0 为地面。'});
      }
      return result;
    }
    if(scene.supports.length) return {ok:false,report:{blockers:[issue('unsupported_combo','supports','一般场运动暂不处理支撑面接触；纯全局竖直重力场可求抛体落斜面。')],pending:[]},flags:['out_of_scope']};

    let projected=false;
    if(link) {
      const x=s0[0]-link.anchor.x,y=s0[1]-link.anchor.y,len=norm(x,y);
      if(len<=0) return {ok:false,report:{blockers:[fail(path+'.pos','小球不能与绳杆锚点重合。')],pending:[]},flags:['conflict']};
      const nx=x/len,ny=y/len,v=s0[2]*nx+s0[3]*ny;
      projected=!near(len,link.length)||!near(v,0);
      s0[0]=link.anchor.x+nx*link.length; s0[1]=link.anchor.y+ny*link.length;
      s0[2]-=v*nx;s0[3]-=v*ny;
    }
    if(!s0.every(finite)||!finite(qm)) return {ok:false,report:{blockers:[fail(path,'参数超出可计算范围。')],pending:[]},flags:['conflict']};
    const sourceBoundaries: Boundary[]=fields.filter(isPointSource).filter(f=>f.kind==='point_mass'||q!==0).map(f=>({
      id:f.id, source:f, shape:{kind:'circle',center:f.position,radius:f.cutoffRadius},
    }));
    const variable=fields.filter(f=>(isPointSource(f)||hasGradient(f))&&(q!==0||f.kind==='uniform_gravity'||f.kind==='point_mass'));
    const usesVariable=(active: Set<string>)=>variable.some(f=>active.has(f.id));
    const zones: Boundary[]=finiteFields.map(f=>({id:f.id,shape:f.shape}));
    const active0=new Set(fields.filter(f=>contains(f.shape,point(s0))).map(f=>f.id));
    const target=(set: Set<string>)=>settings.exit==='field' ? set.has(settings.fieldId!) : zones.some(f=>set.has(f.id));
    const firstEntries=new Map<string,number>();
    const activeSince=new Map([...active0].map(id=>[id,0]));
    const exits=new Map<string,{time:number;start:number}>();
    let unionExit: number | undefined;
    const events: Solution['events']=[];
    const phases: Solution['stages']=[];
    const segments: Segment[]=[];
    const initialForce=sumFields(fields,active0,s0);
    const initialAcc=acceleration(s0,initialForce,qm,link);
    const globalUniform=!zones.length&&!variable.length&&!link;
    const onlyCircular=globalUniform&&qm*initialForce.bz!==0&&initialForce.gx+qm*initialForce.ex===0&&initialForce.gy+qm*initialForce.ey===0;
    const stationary=norm(s0[2],s0[3])===0&&norm(initialAcc.x,initialAcc.y)===0;
    const period=qm*initialForce.bz===0 ? 0 : 2*Math.PI/Math.abs(qm*initialForce.bz);
    const cap=scene.fieldPlayback?.duration ?? (globalUniform ? (onlyCircular ? period : 3) : settings.duration);
    let stop: number|undefined, t=0, s=s0, active=active0, protection=false, incomplete=false;
    let phaseStart=0, phaseLabel='场中运动';
    const changed=(a: Set<string>,b: Set<string>)=>a.size!==b.size||[...a].some(id=>!b.has(id));
    const insideCutoff=(state: State,set: Set<string>)=>sourceBoundaries.find(bd=>set.has(bd.id)&&contains(bd.shape,point(state)));
    const stoppedBySource=(bd: Boundary) => {
      events.push({kind:'source_cutoff',t,label:'到达「'+bd.source!.name+'」最小距离',fieldIds:[bd.id]});
      protection=true;
    };
    const closePhase=()=>{ if(t>phaseStart) phases.push({label:phaseLabel,t0:phaseStart,t1:t}); phaseStart=t; };
    const initialCutoff=insideCutoff(s,active);
    if(initialCutoff) stoppedBySource(initialCutoff);
    else if(link?.kind==='rope'&&initialAcc.radial< -1e-9) {
      events.push({kind:'rope_slack',t,label:'初始条件不能保持绳绷紧'});protection=true;
    } else if(!stationary&&globalUniform) {
      const at=uniformFlow(s,initialForce,m,q);
      if(finite(cap)&&at(cap).every(finite)) {
        segments.push({start:0,end:cap,at,active});t=cap;s=at(t);
      } else incomplete=true;
    } else if(!stationary) {
      let hNext=0.05;
      for(let i=0;t<(stop??cap)&&i<MAX_STEPS;i++) {
        const remaining=(stop??cap)-t;
        if(remaining<=1e-12) break;
        if(events.length>=MAX_EVENTS){incomplete=true;break;}
        const now=sumFields(fields,active,s);
        const relevantSources=sourceBoundaries.filter(bd=>active.has(bd.id));
        const numeric=!!link||usesVariable(active);
        let h=Math.min(hNext,remaining,segmentStep(s,now,qm,relevantSources,link));
        const flow=numeric?rkFlow(s,fields,active,m,q,link):null;
        const at=flow?.at??uniformFlow(s,now,m,q);
        if(!(h>1e-12)||t+h===t){incomplete=true;break;}
        let err=flow?.error(h)??0;
        while((!finite(err)||err>1)&&h>1e-12){h*=0.5;err=flow?.error(h)??0;}
        if(h<=1e-12||!at(h).every(finite)){incomplete=true;break;}
        hNext=Math.min(0.05,err<0.06?h*2:h);
        const crossing=[...zones,...relevantSources].flatMap(bd=>{
          const dt=firstCrossing(bd,bd.source?false:active.has(bd.id),at,h,
            !numeric&&qm*now.bz===0?acceleration(s,now,qm):undefined);
          return dt===null?[]:[{bd,dt}];
        }).sort((a,b)=>a.dt-b.dt);
        let cutoff=crossing[0]?.dt??h;
        const tension=(dt: number)=>{
          const u=at(dt);
          return acceleration(u,sumFields(fields,active,u),qm,link).radial;
        };
        let slack=false;
        if(link?.kind==='rope'&&tension(cutoff)< -1e-9) {
          let lo=0,hi=cutoff;
          for(let j=0;j<40;j++){const d=(lo+hi)/2;if(tension(d)<0)hi=d;else lo=d;}
          if(hi<cutoff||!crossing.length){cutoff=hi;slack=true;}
        }
        // Keep near but physically separate boundaries distinct, even for microsecond trajectories.
        const eventTolerance=Math.max(4e-12,8*Number.EPSILON*t);
        const simultaneous=slack?[]:crossing.filter(entry=>Math.abs(entry.dt-cutoff)<=eventTolerance);
        if(cutoff>0){segments.push({start:t,end:t+cutoff,at,active});t+=cutoff;s=at(cutoff);}
        if(slack){events.push({kind:'rope_slack',t,label:'绳开始松弛；本模型结束'});protection=true;break;}
        const cut=simultaneous.find(e=>e.bd.source);
        if(cut){stoppedBySource(cut.bd);break;}
        if(!simultaneous.length) continue;
        const next=new Set(active);
        for(const {bd} of simultaneous) {
          if(next.delete(bd.id)){
            if(!exits.has(bd.id)) exits.set(bd.id,{time:t,start:activeSince.get(bd.id)??0});
            activeSince.delete(bd.id);
          } else {
            next.add(bd.id);
            if(!firstEntries.has(bd.id)) firstEntries.set(bd.id,t);
            activeSince.set(bd.id,t);
          }
        }
        if(changed(active,next)) {
          const entered=simultaneous.filter(({bd})=>next.has(bd.id)).map(({bd})=>bd.id);
          const left=simultaneous.filter(({bd})=>!next.has(bd.id)).map(({bd})=>bd.id);
          const names=(ids: string[])=>ids.map(id=>fields.find(f=>f.id===id)!.name).join('、');
          events.push({kind:'field_crossing',t,fieldIds:[...left,...entered],label:[left.length?'离开 '+names(left):'',entered.length?'进入 '+names(entered):''].filter(Boolean).join('；')});
          if(unionExit===undefined&&zones.some(bd=>active.has(bd.id))&&!zones.some(bd=>next.has(bd.id))) unionExit=t;
          if(stop===undefined&&settings.exit!=='continue'&&target(active)&&!target(next)) {
            events.push({kind:'field_exit',t,label:'首次出场'});
            stop=t+settings.afterExit;
            closePhase();phaseLabel='出场后续播';
          }
          active=next;
          const source=insideCutoff(s,active);
          if(source){stoppedBySource(source);break;}
        }
      }
      if(!protection&&t+1e-9<(stop??cap)) incomplete=true;
    }
    closePhase();
    if(!phases.length) phases.push({label:stationary&&!protection?'静止':'初始状态',t0:0,t1:0});
    const tEnd=t;
    const continuous=globalUniform&&!protection&&!incomplete;
    const extend=uniformFlow(s0,initialForce,m,q);
    function stateAt(time: number,allowFuture=false): {s: State;active:Set<string>} {
      if(allowFuture&&continuous&&time>tEnd) return {s:extend(time),active:active0};
      const t=Math.min(tEnd,Math.max(0,time));
      // On a shared endpoint, use the following phase (outgoing force).
      let lo=0,hi=segments.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(segments[mid].end<=t)lo=mid+1;else hi=mid;}
      const seg=segments[lo];
      if (!seg) return {s:t===tEnd?s:s0,active};
      return {s:seg.at(Math.max(0,t-seg.start)),active:seg.active};
    }
    const evalAt: Solution['evalAt']=(time)=>{
      const t=Math.min(tEnd,Math.max(0,time));
      const item=stateAt(t),f=sumFields(fields,item.active,item.s),a=acceleration(item.s,f,qm,link);
      const [x,y,vx,vy]=item.s;
      return {t,x,y,vx,vy,s:x-s0[0],ax:a.x,ay:a.y,fieldIds:[...item.active]};
    };
    const defaultExit=settings.exit==='field'?exits.get(settings.fieldId!)?.time:unionExit;
    if(defaultExit!==undefined&&!events.some(e=>e.kind==='field_exit')) events.push({kind:'field_exit',t:defaultExit,label:'首次出场'});
    events.sort((a,b)=>a.t-b.t);
    const samples=[...new Set([0,tEnd,...Array.from({length:399},(_,i)=>tEnd*(i+1)/400),...events.map(e=>e.t)])].sort((a,b)=>a-b).map(evalAt);
    const answers: Answer[]=[];
    const out=(id:string,label:string,value:number|null,unit:string,note?:string)=>answers.push({id,label,value,unit,note});
    const show=(id:string,label:string,time:number)=> {
      const item=stateAt(time,true), [x,y,vx,vy]=item.s, a=acceleration(item.s,sumFields(fields,item.active,item.s),qm,link);
      out(id+'.x',label+'位置 x',x,'m');out(id+'.y',label+'位置 y',y,'m');
      out(id+'.vx',label+'速度 vx',vx,'m/s');out(id+'.vy',label+'速度 vy',vy,'m/s');
      out(id+'.speed',label+'速率',norm(vx,vy),'m/s');
      out(id+'.angle',label+'速度方向（相对 +x）',vx||vy?Math.atan2(vy,vx)*180/Math.PI:null,'°');
      out(id+'.fx',label+'合力 Fx',m*a.x,'N');out(id+'.fy',label+'合力 Fy',m*a.y,'N');
    };
    if(!link&&!usesVariable(active0)&&period>0) {
      const w=qm*initialForce.bz;
      const dx=(initialForce.gy+qm*initialForce.ey)/w,dy=-(initialForce.gx+qm*initialForce.ex)/w;
      out('gyro_radius','初始合场的回旋半径',norm(s0[2]-dx,s0[3]-dy)/Math.abs(w),'m');
      out('gyro_period','初始合场的回旋周期',period,'s','仅在初始合场保持不变时适用。');
      if(initialForce.ex||initialForce.ey||initialForce.gx||initialForce.gy) {
        out('drift_x','初始合场漂移速度 vx',dx,'m/s');out('drift_y','初始合场漂移速度 vy',dy,'m/s');
        if(!initialForce.gx&&!initialForce.gy) out('selector_speed','电磁力抵消所需速率',norm(dx,dy),'m/s','方向必须与所示漂移速度一致。');
      }
    }
    const available=(time:number)=>finite(time)&&time>=0&&(time<=tEnd+1e-10||continuous||stationary&&!protection);
    for (const ask of scene.asks) {
      if(ask.kind==='at_time') {
        if(available(ask.t!)) show(ask.id,'t='+fmt(ask.t)+' s · ',ask.t!);
        else out(ask.id,'指定时刻的状态',null,'','该时刻超出已求解范围。');
      } else if(ask.kind==='field_exit'||ask.kind==='field_entry') {
        const entering=ask.kind==='field_entry';
        const action=entering?'进场':'出场';
        const field=finiteFields.find(f=>f.id===ask.fieldId);
        const label=(field?field.name+' · ':'')+'首次'+action;
        if(!field&&(ask.fieldId||entering)){
          out(ask.id,label+'时间',null,'s','请选择一个已启用且有边界的场区。');
          continue;
        }
        const exit=field?exits.get(field.id):undefined;
        const time=field?(entering?firstEntries.get(field.id):exit?.time):defaultExit;
        if(time===undefined) out(ask.id,label+'时间',null,'s',zones.length
          ? (stationary&&!protection?'粒子保持静止。':'已求解区间内未发现'+action+'。'):'没有已启用的有限场区。');
        else {
          out(ask.id,label+'时间',time,'s');
          // For a named zone, include the observed transit or the interval since t = 0 if it starts inside.
          if(!entering&&exit&&field){
            const entry=stateAt(exit.start), start=entry.s,end=stateAt(exit.time).s;
            const prefix=field.name+' · ';
            out(ask.id+'.dwell',prefix+'场内用时',exit.time-exit.start,'s');
            out(ask.id+'.dx',prefix+'场内位移 Δx',end[0]-start[0],'m');
            out(ask.id+'.dy',prefix+'场内位移 Δy',end[1]-start[1],'m');
            if(field.kind==='uniform_electric'&&!link&&q!==0&&!usesVariable(entry.active)){
              const f=sumFields(fields,entry.active,start);
              if(f.bz!==0&&(f.ex!==0||f.ey!==0)&&f.gx===0&&f.gy===0){
                const vx=f.ey/f.bz, vy=-f.ex/f.bz;
                out(ask.id+'.selector_speed',prefix+'入口的速度选择条件',norm(vx,vy),'m/s',
                  '速度分量需为 ('+fmt(vx)+', '+fmt(vy)+') m/s，才能使电力和磁力抵消。');
              }
            }
            if(field.kind==='uniform_magnetic'&&!link&&exit.time>exit.start) {
              const w=qm*sumFields(fields,entry.active,start).bz;
              const circular=w!==0&&segments.filter(seg=>seg.end>exit.start&&seg.start<exit.time).every(seg=>{
                if(usesVariable(seg.active)) return false;
                const f=sumFields(fields,seg.active,start);
                return qm*f.bz===w&&f.gx+qm*f.ex===0&&f.gy+qm*f.ey===0;
              });
              if(circular){
                out(ask.id+'.radius',prefix+'圆弧半径',norm(start[2],start[3])/Math.abs(w),'m');
                out(ask.id+'.sweep',prefix+'转过圆心角',Math.abs(w)*(exit.time-exit.start)*180/Math.PI,'°',w>0?'顺时针':'逆时针');
              }
            }
          }
          show(ask.id,label+' · ',time);
        }
      } else if(ask.kind!=='energy_at'&&ask.kind!=='work_between') {
        out(ask.id,'此场景的待求量',null,'','当前场模型支持指定时刻、进出场和能量查询。');
      }
    }
    const energy=fieldEnergy({m,q,fields,available,stateAt,samples});
    for(const ask of scene.asks) {
      const resolve=(p?: EnergyPoint)=>{
        if(p?.kind==='time')return p.t;
        if(p?.kind==='event'){
          if(p.event==='initial')return 0;
          if(p.event==='final_rest')return stationary&&!protection?0:null;
          return events.find(e=>e.kind===p.event)?.t??null;
        }
        return null;
      };
      if(ask.kind==='energy_at'){
        const time=resolve(ask.energyFrom), value=time===null?null:energy.evalAt(time);
        if(!value) out(ask.id,'某时刻的能量',null,'J','指定时刻或事件不在已求解范围内。');
        else {
          out(ask.id+'.kinetic','动能',value.kinetic,'J');out(ask.id+'.potential','势能',value.potential,'J',value.potential===null?'裁剪场不设统一势能。':undefined);
          out(ask.id+'.mechanical','机械能',value.mechanical,'J');
        }
      } else if(ask.kind==='work_between') {
        const a=resolve(ask.energyFrom), b=resolve(ask.energyTo), w=a===null||b===null?null:energy.workBetween(a,b);
        if(!w)out(ask.id,'区间做功',null,'J','请选择有效且顺序正确的时刻或事件。');
        else {
          out(ask.id+'.gravity','重力功',w.gravity,'J');out(ask.id+'.electric','电场功',w.electric??0,'J');
          out(ask.id+'.magnetic','磁场功',0,'J');out(ask.id+'.net','合功',w.net,'J');
        }
      }
    }
    const method=link||variable.length?'在变化场或受约束时使用自适应数值积分':'分段使用匀强场解析式';
    const notice=[protection?events.at(-1)?.label:undefined,incomplete?WARNING:undefined,
      projected?'小球初始位置投影到绳杆长度，初速度取切向分量。':undefined].filter(Boolean).join(' ');
    return {ok:true,solution:{
      template:'field',sceneRev:scene.rev,tEnd,stages:phases,events,samples,evalAt,energy,answers,notice,flags:[],
      steps:[...fields.flatMap(f=>f.kind==='uniform_electric'&&f.plates&&f.shape.kind==='rect'?[{
        title:f.name+'：由电压和板间距求电场',
        formula:`E_${f.plates.axis}=\\frac{U}{d}`,
        substitution:`E_${f.plates.axis}=\\frac{${fmt(f.plates.voltage)}}{${fmt(f.plates.axis==='x'?f.shape.width:f.shape.height)}}=${fmt(f.vector[f.plates.axis])}\\,\\mathrm{V/m}`,
        note:'U 为负轴侧板电势减去正轴侧板电势；场区外忽略边缘效应。',
      }]:[]),{title:'按位置叠加各场并计算合力',formula:FORMULA,note:'正 B_z 指向纸外；只使用已放置且启用的场。'},
        ...fields.some(hasGradient)?[{title:'按粒子所在位置计算线性渐变场',
          formula:'F_x(x)=F_{x0}+k_x(x-x_0),\\quad F_y(y)=F_{y0}+k_y(y-y_0),\\quad B_z(x,y)=B_{z0}+k_x(x-x_0)+k_y(y-y_0)',
          note:'F 表示重力场或电场的场强。系数取自各场的属性；匀强场的变化量为 0。'}]:[],
        {title:'求轨迹并定位场区穿越',formula:'\\dot{\\vec r}=\\vec v,\\quad \\dot{\\vec v}=\\vec a',note:method+'；一般边界事件为数值近似。'},
        ...fields.some(f=>f.kind==='uniform_magnetic')?[{title:'匀强磁场中的圆弧与速度选择',formula:'r=\\frac{mv}{|qB_z|},\\quad \\Delta\\theta=\\frac{|qB_z|}{m}\\Delta t,\\quad v_{\\rm sel}=E/B',note:'前两式适用于只有磁力改变速度方向的区段；速度选择要求电力与磁力方向相反且等大。'}]:[],
        {title:'场力的功与动能变化',formula:'W_B=0,\\quad W_g+W_E=\\Delta E_k',note:link?'固定绷紧绳与刚性杆的约束力垂直于速度。':undefined}],
      formulas:[{label:'合加速度',latex:FORMULA}],
    }};
  },
};

function fieldEnergy({m,q,fields,available,stateAt,samples}:{
  m:number;q:number;fields:Field[];available:(t:number)=>boolean;
  stateAt:(t:number,allowFuture?:boolean)=>{s:State};samples:Solution['samples'];
}): Extract<EnergyAnalysis,{status:'ready'}> {
  const hasPotential=fields.every(f=>f.kind==='uniform_magnetic'||f.shape.kind==='global'||q===0&&(f.kind==='uniform_electric'||f.kind==='point_charge'));
  function evalAt(t:number) {
    if(!available(t))return null;
    const {s}=stateAt(t,true),p=point(s);
    const kinetic=0.5*m*(s[2]**2+s[3]**2);
    let potential:number|null=hasPotential?0:null;
    if(potential!==null)for(const f of fields){
      if(f.kind==='uniform_gravity'||f.kind==='uniform_electric'){
        const dx=p.x-f.position.x, dy=p.y-f.position.y;
        const gradient=f.gradient;
        const linear=gradient ? 0.5*((gradient.x ?? 0)*p.x*(dx-f.position.x)+(gradient.y ?? 0)*p.y*(dy-f.position.y)) : 0;
        potential-=(f.kind==='uniform_gravity'?m:q)*(dot(f.vector,p)+linear);
      }
      else if(isPointSource(f)){
        if(f.kind==='point_charge'&&q===0)continue;
        const r=Math.max(f.cutoffRadius,norm(p.x-f.position.x,p.y-f.position.y));
        potential+=(f.kind==='point_mass'?-6.67430e-11*m:8.9875517923e9*q)*f.sourceStrength/r;
      }
    }
    return {t,kinetic,potential,mechanical:potential===null?null:kinetic+potential,dissipated:null};
  }
  return {status:'ready',samples:samples.map(s=>evalAt(s.t)!),evalAt,workBetween(from,to){
    const a=evalAt(from),b=evalAt(to);
    if(!a||!b||to<from)return null;
    const start=stateAt(from,true).s,end=stateAt(to,true).s;
    const gravity=end[4]-start[4],electric=end[5]-start[5],net=gravity+electric;
    const kineticChange=b.kinetic-a.kinetic,mechanicalChange=b.mechanical===null||a.mechanical===null?null:b.mechanical-a.mechanical;
    return {gravity,electric,magnetic:0,net,kineticChange,mechanicalChange,friction:null,dissipated:null,
      balance:Math.abs(net-kineticChange)<=1e-6*Math.max(1,Math.abs(net),Math.abs(kineticChange))?'verified':'mismatch'};
  }};
}
