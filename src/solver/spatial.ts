import { DEFAULT_FIELD_PLAYBACK, hasGradient, isCharged, isPointSource } from '../model/fields';
import type { Answer, EnergyAnalysis, EnergyPoint, Field, Scene, Solution } from '../model/types';
import { fmt } from '../model/units';
import { issue, type Template } from './template';
import { dot3, norm3, position3, spatialAcceleration, spatialForces, spatialRKFlow, spatialUniformFlow, velocity3, type SpatialState } from './spatialMotion';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optional = (v: number | null | undefined) => v === undefined ? 0 : v;
const FORMULA = '\\vec a=\\sum\\vec g+\\frac qm(\\sum\\vec E+\\vec v\\times\\sum\\vec B)';

export const spatialTemplate: Template = {
  id: 'field-3d',
  match: scene => scene.dimension === '3d',
  solve(scene: Scene) {
    const blockers = [];
    const fail = (path: string, message: string) => issue('constraint_conflict',path,message);
    if (scene.bodies.length !== 1 || scene.bodies[0].kind !== 'ball') blockers.push(issue('unsupported_combo','bodies','三维模式支持一个自由小球；物块与双球碰撞请使用二维模式。'));
    if (scene.supports.length || scene.contacts.length || scene.links?.length) blockers.push(issue('unsupported_combo','supports','三维模式暂不支持支撑面、绳杆或接触约束。'));
    const fields = (scene.fields ?? []).filter(f => f.enabled);
    if (new Set(fields.map(f=>f.id)).size !== fields.length) blockers.push(fail('fields','场对象 ID 重复。'));
    for (const f of fields) {
      const path = 'fields.'+f.id;
      if (f.shape.kind !== 'global') blockers.push(issue('unsupported_combo',path+'.shape','三维模式目前支持全局场，请将作用范围改为全局。'));
      if (f.plates) blockers.push(issue('unsupported_combo',path+'.plates','三维模式请直接输入 Ex、Ey、Ez，平行板边界模型请在二维中使用。'));
      if (!['uniform_gravity','uniform_electric','uniform_magnetic','point_mass','point_charge'].includes(f.kind)) blockers.push(fail(path,'未知场类型。'));
      for (const [name,v] of Object.entries({ 'position.x':f.position.x,'position.y':f.position.y,'position.z':optional(f.position.z) })) {
        if (!finite(v)) blockers.push(fail(path+'.'+name,'场源或参考点坐标必须是有限数值。'));
      }
      if (isPointSource(f)) {
        if (!finite(f.sourceStrength) || f.kind === 'point_mass' && f.sourceStrength <= 0 || !finite(f.cutoffRadius) || f.cutoffRadius <= 0) blockers.push(fail(path,'请填写有效源强及正的最小距离。'));
      } else if (f.kind === 'uniform_magnetic') {
        for (const [name,v] of Object.entries({bx:optional(f.bx),by:optional(f.by),bz:f.bz})) if (!finite(v)) blockers.push(fail(path+'.'+name,'磁场分量必须是有限数值。'));
        if (hasGradient(f)) blockers.push(issue('unsupported_combo',path+'.gradient','三维磁场当前支持匀强模式；请关闭线性渐变。'));
      } else {
        for (const key of ['x','y','z'] as const) {
          if (!finite(key === 'z' ? optional(f.vector.z) : f.vector[key])) blockers.push(fail(path+'.vector.'+key,'场强分量必须是有限数值。'));
          if (hasGradient(f) && !finite(key === 'z' ? optional(f.gradient!.z) : f.gradient![key])) blockers.push(fail(path+'.gradient.'+key,'场强变化量必须是有限数值。'));
        }
      }
    }
    const b = scene.bodies[0], path = 'bodies.'+b?.id;
    if (!b) return {ok:false,report:{blockers,pending:[]},flags:['out_of_scope']};
    const q = isCharged(b) ? b.charge : 0;
    for (const [name,v] of Object.entries({charge:q,'pos.x':b.pos.x,'pos.y':b.pos.y,'pos.z':optional(b.pos.z),'vel.x':b.vel.x,'vel.y':b.vel.y,'vel.z':optional(b.vel.z)})) {
      if (!finite(v)) blockers.push(issue('missing_required',path+'.'+name,'请填写有限数值，未知量不能默认为 0。'));
    }
    if (finite(b.mass) && b.mass <= 0) blockers.push(fail(path+'.mass','质量必须为正。'));
    if (isCharged(b) && q === 0) blockers.push(fail(path+'.charge','带电小球需要非零电荷量；中性小球请取消带电。'));
    // 纯重力运动的轨迹与质量无关；使用单位质量继续求运动学量，
    // 但能量/功仍会明确提示需要真实质量。
    const massKnown = finite(b.mass) && b.mass > 0;
    const kinematicsOnly = !massKnown && q === 0
      && fields.every((f) => f.kind === 'uniform_gravity' || f.kind === 'point_mass');
    if (!massKnown && !kinematicsOnly) blockers.push(issue('missing_required',path+'.mass','请填写有限数值，未知量不能默认为 0。'));
    const settings = {...DEFAULT_FIELD_PLAYBACK,...scene.fieldPlayback};
    if (!finite(settings.duration) || settings.duration <= 0) blockers.push(fail('fieldPlayback.duration','演示 / 数值求解时长必须为正。'));
    if (settings.exit !== 'continue') blockers.push(issue('unsupported_combo','fieldPlayback.exit','三维全局场请使用按时长演示；有限场区进出查询请在二维中使用。'));
    if (blockers.length) return {ok:false,report:{blockers,pending:[]},flags:['out_of_scope']};

    const m = massKnown ? b.mass! : 1;
    const charge = q!;
    const initial: SpatialState = [b.pos.x!,b.pos.y!,optional(b.pos.z)!,b.vel.x!,b.vel.y!,optional(b.vel.z)!,0,0];
    const force = spatialForces(fields,initial), initialA = spatialAcceleration(initial,force,charge/m);
    const variable = fields.some(f=>(isPointSource(f)||hasGradient(f)) && (f.kind==='point_mass'||f.kind==='uniform_gravity'||charge!==0));
    const omega = Math.abs(charge/m)*norm3(force.b);
    const stationary = norm3(velocity3(initial)) === 0 && norm3(initialA) === 0;
    const askTime = Math.max(0,...scene.asks.filter(a=>a.kind==='at_time'&&finite(a.t)&&a.t>=0).map(a=>a.t!));
    const cap = scene.fieldPlayback?.duration ?? Math.max(askTime,omega > 0 ? 4*Math.PI/omega : 3);
    if(!finite(charge/m)||!finite(norm3(initialA))||!finite(omega)||!finite(cap)||cap<=0) return {ok:false,report:{blockers:[fail(path,'参数或求解时长超出可计算范围，请调整场强、质量或演示时长。')],pending:[]},flags:['conflict']};
    const exact = spatialUniformFlow(initial,force,m,charge);
    const segments: Array<{start:number;end:number;at:(dt:number)=>SpatialState}> = [];
    const sources = fields.filter(f=>isPointSource(f)&&(f.kind==='point_mass'||charge!==0));
    const distance = (s: SpatialState,f: Field) => Math.hypot(s[0]-f.position.x,s[1]-f.position.y,s[2]-(f.position.z??0));
    const events: Solution['events'] = [];
    let t=0, state=initial, incomplete=false;
    let cutoff=sources.find(f=>distance(state,f)<=f.cutoffRadius);
    if (!cutoff && !stationary && !variable) {
      state=exact(cap);
      if (!state.every(finite)) return {ok:false,report:{blockers:[fail(path,'参数或求解时长超出可计算范围。')],pending:[]},flags:['conflict']};
      t=cap;
    } else if (!cutoff && !stationary) {
      let nextH=.02;
      for (let i=0;i<20000 && t<cap;i++) {
        const f=spatialForces(fields,state), speed=norm3(velocity3(state)), a=norm3(spatialAcceleration(state,f,charge/m));
        let h=Math.min(nextH,cap-t,.08/(Math.abs(charge/m)*norm3(f.b)||1));
        for (const source of sources) {
          const radius=distance(state,source);
          h=Math.min(h,.15*radius/(speed||1),Math.sqrt(.15*radius/(a||1)));
        }
        const flow=spatialRKFlow(state,fields,m,charge);
        let error=flow.error(h);
        while ((!finite(error)||error>1) && h>1e-12) {h/=2;error=flow.error(h);}
        if (h<=1e-12 || t+h===t || !flow.at(h).every(finite)) {incomplete=true;break;}
        // Probe the continuous trial step, including its interior, before accepting a source cutoff.
        let eventH=h;
        for (const source of sources) {
          for (let j=1;j<=4;j++) {
            const hi0=h*j/4;
            if (distance(flow.at(hi0),source)>source.cutoffRadius) continue;
            let lo=h*(j-1)/4,hi=hi0;
            for (let k=0;k<45;k++) {const mid=(lo+hi)/2;if(distance(flow.at(mid),source)>source.cutoffRadius)lo=mid;else hi=mid;}
            if(hi<=eventH){eventH=hi;cutoff=source;}
            break;
          }
        }
        segments.push({start:t,end:t+eventH,at:flow.at});
        state=flow.at(eventH);t+=eventH;
        if(cutoff)break;
        nextH=Math.min(.05,error<.06?h*2:h);
      }
      if(!cutoff&&t<cap-1e-9)incomplete=true;
    }
    if(cutoff)events.push({kind:'source_cutoff',t,label:'到达「'+cutoff.name+'」最小距离'});
    const tEnd=t;
    const available=(time:number)=>finite(time)&&time>=0&&(!variable&&!cutoff||stationary&&!cutoff||time<=tEnd+1e-10);
    const stateAt=(time:number):SpatialState=>{
      if(stationary || time===0)return initial;
      if(!variable)return exact(time);
      if(time>=tEnd)return state;
      let lo=0,hi=segments.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(segments[mid].end<=time)lo=mid+1;else hi=mid;}
      const segment=segments[lo];
      return segment?segment.at(time-segment.start):state;
    };
    const sampleAt=(time:number)=>{
      const u=stateAt(time),a=spatialAcceleration(u,spatialForces(fields,u),charge/m);
      return {t:time,x:u[0],y:u[1],z:u[2],vx:u[3],vy:u[4],vz:u[5],s:Math.hypot(u[0]-initial[0],u[1]-initial[1],u[2]-initial[2]),ax:a.x,ay:a.y,az:a.z,fieldIds:fields.map(f=>f.id)};
    };
    const evalAt:Solution['evalAt']=(time)=>sampleAt(Math.max(0,Math.min(tEnd,time)));
    const count=Math.min(1600,Math.max(400,Math.ceil(omega*tEnd*20)));
    const samples=tEnd===0?[evalAt(0)]:Array.from({length:count+1},(_,i)=>evalAt(i*tEnd/count));
    const energyAt=(time:number)=>{
      if(!massKnown)return null;
      if(!available(time))return null;
      const u=stateAt(time),p=position3(u);
      const kinetic=.5*m*dot3(velocity3(u),velocity3(u));
      let potential=0;
      for(const f of fields) {
        if(isPointSource(f)){
          if(f.kind==='point_charge'&&charge===0)continue;
          const r=Math.max(distance(u,f),f.cutoffRadius);
          potential+=(f.kind==='point_mass'?-6.67430e-11*m:8.9875517923e9*charge)*f.sourceStrength/r;
        } else if(f.kind!=='uniform_magnetic') {
          const factor=f.kind==='uniform_gravity'?m:charge;
          const d={x:p.x-f.position.x,y:p.y-f.position.y,z:p.z-(f.position.z??0)};
          potential-=factor*(f.vector.x*d.x+f.vector.y*d.y+(f.vector.z??0)*d.z+((f.gradient?.x??0)*d.x*d.x+(f.gradient?.y??0)*d.y*d.y+(f.gradient?.z??0)*d.z*d.z)/2);
        }
      }
      if(!finite(kinetic)||!finite(potential))return null;
      return {t:time,kinetic,potential,mechanical:kinetic+potential,dissipated:0};
    };
    const energySamples=samples.map(s=>energyAt(s.t));
    if((massKnown&&energySamples.some(s=>s===null))||samples.some(s=>![s.x,s.y,s.z,s.vx,s.vy,s.vz,s.ax,s.ay,s.az].every(finite)))return {ok:false,report:{blockers:[fail(path,'运动或能量超出可计算范围，请调整参数。')],pending:[]},flags:['conflict']};
    const energy: EnergyAnalysis = !massKnown
      ? { status:'mass_required', note:'请在物体属性中填写大于 0 的质量，才能计算以焦耳表示的能量和功。' }
      : {
        status:'ready',samples:energySamples.filter((s):s is NonNullable<typeof s>=>s!==null),evalAt:energyAt,
        workBetween(from,to){
          if(to<from)return null;
          const a=energyAt(from),b=energyAt(to);
          if(!a||!b)return null;
          const ua=stateAt(from),ub=stateAt(to),gravity=ub[6]-ua[6],electric=ub[7]-ua[7],kineticChange=b.kinetic-a.kinetic;
          return {gravity,electric,magnetic:0,friction:0,net:gravity+electric,dissipated:0,kineticChange,mechanicalChange:b.mechanical-a.mechanical,
            balance:Math.abs(gravity+electric-kineticChange)<=1e-6*Math.max(1,Math.abs(kineticChange),a.kinetic,b.kinetic)?'verified':'mismatch'};
        },
      };
    const answers:Answer[]=[];
    const out=(id:string,label:string,value:number|null,unit:string,note?:string)=>answers.push({id,label,value,unit,note});
    const resolve=(p?:EnergyPoint)=>p?.kind==='time'?p.t:p?.kind==='event'?(p.event==='initial'||p.event==='final_rest'&&stationary?0:events.find(e=>e.kind===p.event)?.t??null):null;
    if(!variable&&omega>0) {
      const v=velocity3(initial),parallel=dot3(v,force.b)/norm3(force.b);
      out('gyro_period','回旋周期',2*Math.PI/omega,'s');
      if(Math.hypot(force.g.x+charge/m*force.e.x,force.g.y+charge/m*force.e.y,force.g.z+charge/m*force.e.z)===0) {
        out('gyro_radius','回旋半径',Math.sqrt(Math.max(0,norm3(v)**2-parallel**2))/omega,'m');
        out('helix_pitch','螺距（沿合磁场正向）',parallel*2*Math.PI/omega,'m');
      }
    }
    for(const ask of scene.asks) {
      if(ask.kind==='at_time') {
        if(!available(ask.t!)){out(ask.id,'指定时刻的空间状态',null,'','该时刻超出已求解范围。');continue;}
        const s=sampleAt(ask.t!);
        if(!Object.values(s).filter(v=>typeof v==='number').every(finite)){out(ask.id,'指定时刻的空间状态',null,'','该时刻超出可计算范围。');continue;}
        for(const key of ['x','y','z','vx','vy','vz','ax','ay','az'] as const)out(ask.id+'.'+key,'t='+fmt(ask.t)+' s · '+key,s[key],key.startsWith('a')?'m/s²':key.startsWith('v')?'m/s':'m');
        out(ask.id+'.speed','空间速率',Math.hypot(s.vx,s.vy,s.vz),'m/s');
      } else if(ask.kind==='energy_at') {
        if(energy.status!=='ready'){out(ask.id,'能量',null,'J',energy.note);continue;}
        const time=resolve(ask.energyFrom),e=time===null?null:energyAt(time);
        if(e){out(ask.id+'.kinetic','动能',e.kinetic,'J');out(ask.id+'.potential','势能',e.potential,'J');out(ask.id+'.mechanical','机械能',e.mechanical,'J');}
        else out(ask.id,'能量',null,'J','指定时刻或事件不可用。');
      } else if(ask.kind==='work_between') {
        if(energy.status!=='ready'){out(ask.id,'区间做功',null,'J',energy.note);continue;}
        const from=resolve(ask.energyFrom),to=resolve(ask.energyTo),w=from===null||to===null?null:energy.workBetween(from,to);
        if(w){out(ask.id+'.gravity','重力功',w.gravity,'J');out(ask.id+'.electric','电场功',w.electric??0,'J');out(ask.id+'.magnetic','磁场功',0,'J');out(ask.id+'.net','合功',w.net,'J');}
        else out(ask.id,'区间做功',null,'J','请选择有效且顺序正确的时刻或事件。');
      } else out(ask.id,'三维场景的待求量',null,'','当前支持指定时刻的三维状态、能量和做功。');
    }
    return {ok:true,solution:{template:'field-3d',sceneRev:scene.rev,tEnd,evalAt,samples,energy,answers,events,flags:[],
      stages:[{label:stationary?'静止':'三维场运动',t0:0,t1:tEnd}],
      notice:incomplete?'达到数值计算保护上限，后续运动尚未确定。':cutoff?events[0].label:undefined,
      steps:[
        {title:'叠加空间场，按三维叉积计算加速度',formula:FORMULA,note:'仅使用已放置并启用的场；三维自由空间不默认附加地面。'},
        {title:'分别求三个方向的运动',formula:'\\dot{\\vec r}=\\vec v,\\quad\\dot{\\vec v}=\\vec a,\\quad\\vec r=(x,y,z)',note:variable?'变化场使用自适应数值积分，达到点源最小距离时停止。':'匀强叠加场使用解析式；平行于磁场的速度产生沿磁场方向的运动。'},
        {title:'分解平行与垂直于磁场的速度',formula:'\\vec v_{\\parallel}=(\\vec v\\cdot\\hat{\\vec B})\\hat{\\vec B},\\quad\\vec v_{\\perp}=\\vec v-\\vec v_{\\parallel}'},
        {title:'纯匀强磁场中的螺旋运动',formula:'R=\\frac{m|v_{\\perp}|}{|q|B},\\quad T=\\frac{2\\pi m}{|q|B},\\quad h=v_{\\parallel}T',note:'适用于带电小球、非零合磁场且无其他合力的情形；平行速度为零时退化为圆。'},
        {title:'核对空间速率与能量',formula:'v=\\sqrt{v_x^2+v_y^2+v_z^2},\\quad E_k=\\frac12mv^2,\\quad W_B=0,\\quad W_g+W_E=\\Delta E_k'},
      ],formulas:[{label:'三维洛伦兹力',latex:'\\vec F=q(\\vec E+\\vec v\\times\\vec B)'},{label:'空间速率',latex:'v=\\sqrt{v_x^2+v_y^2+v_z^2}'}],
    }};
  },
};
