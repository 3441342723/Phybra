import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldKind, Scene, Solution, SpatialVector, Vec2, Vec3 } from '../model/types';
import { makeAsk, makeBall, makeField } from '../model/factory';
import { FIELD_COLORS, FIELD_LABELS, isPointSource } from '../model/fields';
import { resolveBindings } from '../model/paths';
import { DEFAULT_ROTATION, projectSpace, unprojectSpace } from '../model/projection';
import { snapPoint } from '../model/snap';
import { fmt } from '../model/units';
import { withField } from '../state/editing';
import type { Action, Camera, Store } from '../state/store';
import { CanvasLabels, labelObstacle, type CanvasLabel } from './CanvasLabels';
import type { Edit } from './Canvas';
import { defaultLayout, workspaceLayout, type WindowLayout } from '../state/layout';
import { fitSpatialCamera } from '../state/spatial';

type Drag = {pointer:number;start:Vec2;camera:Camera} & (
  {kind:'pan'} | {kind:'rotate'} | {kind:'body'|'velocity'|'field';id:string;z:number;origin:Vec3}
);
const VSCALE=12;

export function SpatialCanvas({store,dispatch,solution,edit,layout}:{store:Store;dispatch:(a:Action)=>void;solution:Solution|null;edit:Edit;layout?:WindowLayout}) {
  const ref=useRef<HTMLDivElement>(null),drag=useRef<Drag|null>(null);
  const [size,setSize]=useState({w:900,h:520}),[rotate,setRotate]=useState(false);
  const scene=store.present,cam=store.camera,rotation=cam.rotation??DEFAULT_ROTATION;
  const resolved=useMemo(()=>resolveBindings(scene),[scene]);
  useEffect(()=>{
    if(!ref.current)return;
    const observer=new ResizeObserver(([entry])=>setSize({w:entry.contentRect.width,h:entry.contentRect.height}));
    observer.observe(ref.current);return ()=>observer.disconnect();
  },[]);
  const toScreen=(p:SpatialVector):Vec2=>{
    const q=projectSpace(p,rotation);return {x:cam.ox+q.x*cam.scale,y:cam.oy-q.y*cam.scale};
  };
  const toWorld=(p:Vec2,z=0)=>unprojectSpace({x:(p.x-cam.ox)/cam.scale,y:(cam.oy-p.y)/cam.scale},z,rotation);
  const local=(e:{clientX:number;clientY:number})=>{const rect=ref.current!.getBoundingClientRect();return {x:e.clientX-rect.left,y:e.clientY-rect.top};};
  const asPoint=(p:{x:number|null;y:number|null;z?:number|null}):Vec3|null=>p.x===null||p.y===null||p.z===null?null:{x:p.x,y:p.y,z:p.z??0};
  function begin(e:React.PointerEvent) {
    if(drag.current || ![0,1,2].includes(e.button))return;
    const p=local(e),base={pointer:e.pointerId,start:p,camera:{...cam}};
    if(e.button===2||e.altKey||e.shiftKey||rotate)drag.current={...base,kind:'rotate'};
    else if(e.button===1||store.tool==='pan')drag.current={...base,kind:'pan'};
    else {
      const node=e.target as Element;
      const velocityId=node.closest('[data-spatial-velocity]')?.getAttribute('data-spatial-velocity');
      const bodyId=node.closest('[data-spatial-body]')?.getAttribute('data-spatial-body');
      const fieldId=node.closest('[data-spatial-field]')?.getAttribute('data-spatial-field');
      const body=resolved.bodies.find(b=>b.id===(velocityId??bodyId)),field=resolved.fields?.find(f=>f.id===fieldId);
      const creating=store.tool==='ball'||Object.hasOwn(FIELD_LABELS,store.tool);
      if(body&&!creating){
        const pos=asPoint(body.pos),vel=asPoint(body.vel);
        if(!pos||!vel)return;
        dispatch({type:'select',id:body.id});
        drag.current={...base,kind:velocityId?'velocity':'body',id:body.id,z:velocityId?vel.z:pos.z,origin:velocityId?vel:pos};
        edit.begin();
      } else if(field&&!creating){
        dispatch({type:'select',id:field.id});
        drag.current={...base,kind:'field',id:field.id,z:field.position.z??0,origin:{...field.position,z:field.position.z??0}};
        edit.begin();
      } else {
        const world={...snapPoint(toWorld(p),store.snap),z:0};
        let next:Scene|null=null,id:string|null=null;
        if(store.tool==='ball'){
          const created=makeBall(world);id=created.id;
          next={...scene,bodies:[...scene.bodies,created],asks:scene.asks.length?scene.asks:[makeAsk('at_time',{t:1})],rev:scene.rev+1};
        } else if(Object.hasOwn(FIELD_LABELS,store.tool)){
          const created=makeField(store.tool as FieldKind,world,{kind:'global'});
          created.vector={...created.vector,z:0};id=created.id;
          next={...scene,fields:[...(scene.fields??[]),created],rev:scene.rev+1};
        }
        if(next){edit.apply(next);dispatch({type:'select',id});return;}
        dispatch({type:'select',id:null});drag.current={...base,kind:'pan'};
      }
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function move(e:React.PointerEvent){
    const d=drag.current;if(!d||d.pointer!==e.pointerId)return;
    const p=local(e),dx=p.x-d.start.x,dy=p.y-d.start.y;
    if(d.kind==='pan')dispatch({type:'camera',camera:{...d.camera,ox:d.camera.ox+dx,oy:d.camera.oy+dy}});
    else if(d.kind==='rotate'){
      const r=d.camera.rotation??DEFAULT_ROTATION;
      const nextRotation={yaw:Math.max(-70,Math.min(70,r.yaw+dx*.35)),pitch:Math.max(-65,Math.min(65,r.pitch-dy*.35))};
      const positions=samples.length?samples:resolved.bodies.flatMap(b=>{const p=asPoint(b.pos);return p?[p]:[];});
      const center={x:0,y:0,z:0};
      for(const p of positions){center.x+=p.x/positions.length;center.y+=p.y/positions.length;center.z+=(p.z??0)/positions.length;}
      const before=projectSpace(center,r),after=projectSpace(center,nextRotation);
      dispatch({type:'camera',camera:{...d.camera,rotation:nextRotation,ox:d.camera.ox+(before.x-after.x)*cam.scale,oy:d.camera.oy+(after.y-before.y)*cam.scale}});
    } else if(d.kind==='velocity'){
      const body=resolved.bodies.find(b=>b.id===d.id),pos=body&&asPoint(body.pos);if(!pos)return;
      const base=toScreen(pos),vel=unprojectSpace({x:(p.x-base.x)/VSCALE,y:(base.y-p.y)/VSCALE},d.z,rotation);
      edit.transient(withField(scene,'bodies.'+d.id+'.vel',{x:Number(vel.x.toFixed(3)),y:Number(vel.y.toFixed(3)),z:d.z}));
    } else {
      const a=toWorld(d.start,d.z),b=toWorld(p,d.z);
      const target={...snapPoint({x:d.origin.x+b.x-a.x,y:d.origin.y+b.y-a.y},store.snap),z:d.z};
      edit.transient(withField(scene,(d.kind==='body'?'bodies.':'fields.')+d.id+(d.kind==='body'?'.pos':'.position'),target));
    }
  }
  function end(e:React.PointerEvent){
    const d=drag.current;if(!d||d.pointer!==e.pointerId)return;
    drag.current=null;
    if(d.kind!=='pan'&&d.kind!=='rotate')edit.end();
  }
  const samples=solution?.template==='field-3d'?solution.samples:[];
  const ready=samples.length>0,sceneKey=scene.bodies.map(b=>b.id).join(',')+'|'+(scene.fields??[]).map(f=>f.id).join(',');
  function fitView(camera=cam){
    const points=[...samples,...resolved.bodies.flatMap(b=>{const p=asPoint(b.pos);return p?[p]:[];}),...(resolved.fields??[]).map(f=>f.position)];
    const view=workspaceLayout(layout??defaultLayout(size.w,size.h),size.w,size.h,null);
    return fitSpatialCamera(camera,points,view,size.w,size.h);
  }
  useEffect(()=>{
    if(!ready)return;
    dispatch({type:'camera',camera:fitView()});
  },[size.w,size.h,ready,sceneKey]); // Fit on scene load and viewport resize, preserving deliberate pans and edits.
  const moving=solution?.template==='field-3d'&&(store.playback.t>0||store.playback.mode==='playing')?solution.evalAt(store.playback.t):null;
  const points=resolved.bodies.flatMap(b=>{const pos=asPoint(b.pos);return pos?[{body:b,pos,screen:toScreen(pos)}]:[];});
  const labels:CanvasLabel[]=[],obstacles:ReturnType<typeof labelObstacle>[]=[];
  obstacles.push({x:size.w-130,y:size.h-120,w:120,h:116},{x:8,y:size.h-48,w:Math.min(280,size.w-150),h:48});
  for(const {body,screen} of points){
    labels.push({id:body.id,at:screen,text:body.name+(moving?'（初始）':''),tone:'object',priority:3});obstacles.push(labelObstacle(screen,14));
  }
  const fields=(resolved.fields??[]).map((f,index)=>{
    const p=toScreen(f.position),point=isPointSource(f),screen=point?p:{x:p.x+index*34,y:p.y};
    labels.push({id:f.id,at:screen,text:f.name,tone:'object',priority:1});obstacles.push(labelObstacle(screen,11));
    return {f,screen,point};
  });
  const current=moving??samples[0],currentPoint=current?toScreen(current):null;
  if(moving&&currentPoint){labels.push({id:'moving',at:currentPoint,text:'t='+fmt(moving.t)+' s · ('+fmt(moving.x)+', '+fmt(moving.y)+', '+fmt(moving.z??0)+') m',tone:'moving',priority:5});obstacles.push(labelObstacle(currentPoint,14));}
  let step=1;while(step*cam.scale<30)step*=2;
  const extent=Math.max(8,Math.min(80,Math.max(size.w,size.h)/cam.scale)),grid=[];
  for(let i=-Math.ceil(extent/step);i<=Math.ceil(extent/step);i++){
    const a=toScreen({x:i*step,y:-extent,z:0}),b=toScreen({x:i*step,y:extent,z:0}),c=toScreen({x:-extent,y:i*step,z:0}),d=toScreen({x:extent,y:i*step,z:0});
    grid.push(<path key={i} d={'M '+a.x+' '+a.y+' L '+b.x+' '+b.y+' M '+c.x+' '+c.y+' L '+d.x+' '+d.y} className="grid"/>);
  }
  const axes=[{name:'x',v:{x:1,y:0,z:0},color:'#dc2626'},{name:'y',v:{x:0,y:1,z:0},color:'#047857'},{name:'z',v:{x:0,y:0,z:1},color:'#2563eb'}];
  const origin=toScreen({x:0,y:0,z:0}),axisLength=Math.max(3,Math.min(8,size.w/cam.scale/3));
  function arrow(a:Vec2,b:Vec2,color:string,key:string){
    const angle=Math.atan2(b.y-a.y,b.x-a.x),len=Math.hypot(b.x-a.x,b.y-a.y);
    return <g key={key} stroke={color} strokeWidth={1.8} fill="none" pointerEvents="none">
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}/>{len>2&&<path d={'M '+(b.x-7*Math.cos(angle-.45))+' '+(b.y-7*Math.sin(angle-.45))+' L '+b.x+' '+b.y+' L '+(b.x-7*Math.cos(angle+.45))+' '+(b.y-7*Math.sin(angle+.45))}/>}
    </g>;
  }
  return <div className="canvas-wrap spatial-canvas">
    <div className="canvas-area" ref={ref}>
      <svg width={size.w} height={size.h} className={'tool-'+store.tool} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onContextMenu={e=>e.preventDefault()} onWheel={e=>{
          const p=local(e),factor=Math.exp(-e.deltaY*.0012),scale=Math.min(400,Math.max(6,cam.scale*factor)),ratio=scale/cam.scale;
          dispatch({type:'camera',camera:{...cam,scale,ox:p.x-(p.x-cam.ox)*ratio,oy:p.y-(p.y-cam.oy)*ratio}});
        }}>
        <rect width={size.w} height={size.h} className="spatial-background"/>
        <g pointerEvents="none">{grid}</g>
        <g className="spatial-axes" pointerEvents="none">
          {axes.map(axis=>{
            const a=toScreen({x:-axis.v.x*axisLength,y:-axis.v.y*axisLength,z:-axis.v.z*axisLength}),b=toScreen({x:axis.v.x*axisLength,y:axis.v.y*axisLength,z:axis.v.z*axisLength});
            return <g key={axis.name} data-axis={axis.name}>{arrow(a,b,axis.color,axis.name)}<text x={b.x+6} y={b.y-6} fill={axis.color}>{axis.name}</text></g>;
          })}
          <circle cx={origin.x} cy={origin.y} r={3} fill="#475569"/>
        </g>
        {samples.length>1&&<polyline className="trajectory spatial-trajectory" points={samples.map(s=>{const p=toScreen(s);return p.x.toFixed(2)+','+p.y.toFixed(2);}).join(' ')} pointerEvents="none"/>}
        {fields.map(({f,screen,point})=>{
          const vector=f.kind==='uniform_magnetic'?{x:f.bx??0,y:f.by??0,z:f.bz}:{x:f.vector.x,y:f.vector.y,z:f.vector.z??0};
          const mag=Math.hypot(vector.x,vector.y,vector.z),v=projectSpace(vector,rotation),tip={x:screen.x+(mag?v.x*28/mag:0),y:screen.y-(mag?v.y*28/mag:0)};
          return <g key={f.id} data-spatial-field={f.id} style={{color:FIELD_COLORS[f.kind],opacity:f.enabled?1:.4}} className="spatial-field">
            <title>{f.name+(point?'（固定场源）':'（全局）')}</title>
            <circle cx={screen.x} cy={screen.y} r={9} className="field-glyph"/>
            {point?<text x={screen.x} y={screen.y+4} textAnchor="middle" fill="currentColor">{f.kind==='point_mass'?'M':f.sourceStrength<0?'−':'+'}</text>:arrow(screen,tip,FIELD_COLORS[f.kind],f.id)}
          </g>;
        })}
        {points.map(({body,pos,screen})=>{
          const vel=asPoint(body.vel),selected=store.selection===body.id||store.tool==='velocity',pv=vel?projectSpace(vel,rotation):null;
          const tip=pv?{x:screen.x+pv.x*VSCALE,y:screen.y-pv.y*VSCALE}:null;
          const floor=toScreen({...pos,z:0});
          return <g key={body.id}>
            {pos.z!==0&&<line x1={screen.x} y1={screen.y} x2={floor.x} y2={floor.y} className="spatial-drop" pointerEvents="none"/>}
            <circle data-spatial-body={body.id} cx={screen.x} cy={screen.y} r={12} className={moving?'initial-body':'body-projectile'}><title>{body.name+' · z='+fmt(pos.z)+' m'}</title></circle>
            {selected&&tip&&<>{arrow(screen,tip,'#047857','velocity')}<circle data-spatial-velocity={body.id} cx={tip.x} cy={tip.y} r={7} className="handle velocity"><title>在固定 vz 下编辑 vx、vy；vz 在属性中设置</title></circle></>}
          </g>;
        })}
        {moving&&currentPoint&&<g className="moving-body" data-time={moving.t} pointerEvents="none">
          <circle cx={currentPoint.x} cy={currentPoint.y} r={12} className="body-projectile"/>
          <line x1={currentPoint.x} y1={currentPoint.y} x2={toScreen({...moving,z:0}).x} y2={toScreen({...moving,z:0}).y} className="spatial-drop"/>
        </g>}
        <CanvasLabels labels={labels} obstacles={obstacles} size={size}/>
        <g className="spatial-compass" transform={'translate('+(size.w-70)+' '+(size.h-64)+')'} pointerEvents="none" aria-label="三维坐标方向">
          <rect x={-59} y={-55} width={118} height={108} rx={9}/>
          {axes.map(axis=>{const p=projectSpace(axis.v,rotation),tip={x:p.x*38,y:-p.y*38};return <g key={axis.name}>{arrow({x:0,y:0},tip,axis.color,axis.name)}<text x={tip.x+3} y={tip.y-3} fill={axis.color}>{axis.name}</text></g>;})}
        </g>
      </svg>
      <div className="spatial-controls" aria-label="三维视角">
        <button className={rotate?'active':''} aria-pressed={rotate} onClick={()=>setRotate(!rotate)} title="也可按住右键、Shift 或 Alt 拖动旋转">旋转视角</button>
        <button onClick={()=>dispatch({type:'camera',camera:fitView({...cam,ox:size.w*.48,oy:size.h*.48,scale:46,rotation:DEFAULT_ROTATION})})}>复位视角</button>
        <button onClick={()=>dispatch({type:'camera',camera:fitView({...cam,rotation:{yaw:0,pitch:0}})})}>正视 xy</button>
      </div>
    </div>
    <div className="canvas-status"><span>三维 · 右键拖动旋转 · 拖动物体保持 z · 在属性中编辑 z / vz</span></div>
  </div>;
}
