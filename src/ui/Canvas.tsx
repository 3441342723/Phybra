import { useEffect, useMemo, useRef, useState } from 'react';
import type { Body, Field, FieldKind, Link, Scene, Solution, Vec2 } from '../model/types';
import { bodyWorld, nearestSupport, projectToSupport, supportDir, supportEnd, supportLength } from '../model/geometry';
import { makeAsk, makeBall, makeBlock, makeContact, makeField, makeLink, makeSupport } from '../model/factory';
import { FIELD_COLORS, FIELD_LABELS, hasGradient, shapeCenter, shapeVertices, translateShape, validPolygon } from '../model/fields';
import { resolveBindings } from '../model/paths';
import { fmt } from '../model/units';
import { FieldLayer } from './FieldLayer';
import { withField } from '../state/editing';
import { snapPoint, snapValue } from '../model/snap';
import { buildSurfaceTrack, trackSegmentAt } from '../model/track';
import type { Action, Camera, Store } from '../state/store';
import { CanvasLabels, labelObstacle, type CanvasLabel } from './CanvasLabels';

export type Edit = {
  begin: () => void;
  transient: (scene: Scene) => void;
  end: () => void;
  apply: (scene: Scene) => void;
};

type Drag =
  | { kind: 'pan'; startX: number; startY: number; cam: Camera }
  | { kind: 'body'; id: string }
  | { kind: 'support'; id: string; start: Vec2; origA: Vec2 }
  | { kind: 'endpoint'; id: string; end: 'a' | 'b' }
  | { kind: 'field'; id: string; handle: string; start: Vec2; original: Field }
  | { kind: 'link'; id: string; start: Vec2; original: Link }
  | { kind: 'velocity'; id: string };

const VSCALE = 12;

export function Canvas({ store, dispatch, solution, edit }: { store: Store; dispatch: (a: Action) => void; solution: Solution | null; edit: Edit }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [size, setSize] = useState({ w: 900, h: 520 });
  const [polygon, setPolygon] = useState<Vec2[]>([]);
  const [polygonKind, setPolygonKind] = useState<FieldKind>('uniform_gravity');
  const scene = store.present;
  const cam = store.camera;
  const sceneFields = scene.fields ?? [];
  const links = scene.links ?? [];
  const resolved = useMemo(() => resolveBindings(scene), [scene]);
  const visibleFields = resolved.fields ?? [];
  const twoBalls=scene.bodies.length===2&&scene.bodies.every(b=>b.kind==='ball');
  const bodyRadius=(body:Body)=>twoBalls?Math.max(1,(resolved.bodies.find(b=>b.id===body.id)?.collisionRadius??0.25)*cam.scale):12;

  useEffect(() => { if (store.tool !== 'field_polygon') setPolygon([]); }, [store.tool]);
  const track = useMemo(() => {
    const attached = resolved.bodies[0]?.attach;
    if (!solution || !attached) return null;
    const built = buildSurfaceTrack(resolved, attached.support);
    return built.segments.length ? built : null;
  }, [resolved, solution]);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const w2s = (p: Vec2) => ({ x: cam.ox + p.x * cam.scale, y: cam.oy - p.y * cam.scale });
  const s2w = (p: Vec2) => ({ x: (p.x - cam.ox) / cam.scale, y: (cam.oy - p.y) / cam.scale });
  const local = (e: { clientX: number; clientY: number }): Vec2 => {
    const rect = ref.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

  function bodyScreen(body: Body): Vec2 | null {
    const p = bodyWorld(scene, body);
    if (!p) return null;
    const link=links.find(l=>l.bodyId===body.id);
    const r=link?dist(p,link.anchor):0;
    return w2s(link&&r>0?{x:link.anchor.x+(p.x-link.anchor.x)*link.length/r,y:link.anchor.y+(p.y-link.anchor.y)*link.length/r}:p);
  }

  function velocityTip(body: Body): Vec2 | null {
    if (body.kind === 'circular') return null;
    const base = bodyScreen(body);
    if (!base) return null;
    if (body.attach) {
      const sup = scene.supports.find((s) => s.id === body.attach!.support);
      if (!sup) return null;
      const d = supportDir(sup);
      const u = (body.vel.x ?? 0) * d.x + (body.vel.y ?? 0) * d.y;
      return { x: base.x + d.x * u * VSCALE, y: base.y - d.y * u * VSCALE };
    }
    return { x: base.x + (body.vel.x ?? 0) * VSCALE, y: base.y - (body.vel.y ?? 0) * VSCALE };
  }

  function hitTest(p: Vec2): Drag | null {
    for (const body of scene.bodies) {
      if (store.selection === body.id || store.tool === 'velocity') {
        const tip = velocityTip(body);
        if (tip && dist(p, tip) < 14) return { kind: 'velocity', id: body.id };
      }
    }
    for (const sup of scene.supports) {
      if (store.selection === sup.id) {
        if (dist(p, w2s(sup.a)) < 12) return { kind: 'endpoint', id: sup.id, end: 'a' };
        if (dist(p, w2s(supportEnd(sup))) < 12) return { kind: 'endpoint', id: sup.id, end: 'b' };
      }
    }
    for (const body of scene.bodies) {
      const bp = bodyScreen(body);
      if (bp && dist(p, bp) < Math.max(20,bodyRadius(body))) return { kind: 'body', id: body.id };
    }
    for (const sup of scene.supports) {
      const a = w2s(sup.a);
      const b = w2s(supportEnd(sup));
      const len = dist(a, b);
      const t = len < 1 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len)));
      const proj = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (dist(p, proj) < 9) return { kind: 'support', id: sup.id, start: s2w(p), origA: { ...sup.a } };
    }
    return null;
  }

  function createAt(pointer: Vec2) {
    const world = snapPoint(pointer, store.snap);
    let next = scene;
    let created = '';
    if (store.tool === 'ball') {
      const b = makeBall(world);
      b.name = '小球 ' + (scene.bodies.filter(item=>item.kind==='ball').length+1);
      next = { ...next, bodies: [...next.bodies, b] };
      if (next.asks.length === 0) next = { ...next, asks: [makeAsk('at_time', { t: 1 })] };
      created = b.id;
    } else if (Object.hasOwn(FIELD_LABELS,store.tool)) {
      const f=makeField(store.tool as FieldKind,world);
      f.name+=` ${sceneFields.length+1}`;
      next={...next,fields:[...sceneFields,f]};
      created=f.id;
    } else if (store.tool === 'rope' || store.tool === 'rod') {
      const ball=scene.bodies.find(b=>b.kind==='ball'&&!links.some(l=>l.bodyId===b.id));
      const pos=ball?bodyWorld(scene,ball):null;
      const length=pos?dist(pos,world):2;
      if(length<1e-6){
        dispatch({type:'notice',text:'绳杆锚点不能与小球重合。'});
        return;
      }
      const link=makeLink(store.tool,world,ball?.id??null,length);
      next={...next,links:[...links,link]};
      created=link.id;
    } else if (store.tool === 'incline') {
      const sup = makeSupport('incline', world, 5, 30);
      sup.name = `斜面 ${next.supports.length + 1}`;
      const contacts = next.bodies.filter((b) => b.kind === 'block').map((b) => makeContact(b.id, sup.id, 0.4, 0.3));
      next = { ...next, supports: [...next.supports, sup], contacts: [...next.contacts, ...contacts] };
      created = sup.id;
    } else if (store.tool === 'block') {
      const sup = nearestSupport(next.supports, world, 1.5);
      if (!sup) {
        dispatch({ type: 'notice', text: '请先从「对象」放置斜面（倾角 0° 为水平面），再点击斜面放置物块。' });
        return;
      }
      const s = snapValue(projectToSupport(sup, world), store.snap);
      const block = makeBlock(sup.id, s);
      const contacts = next.supports.map((support) => makeContact(block.id, support.id, 0.4, 0.3));
      next = { ...next, bodies: [...next.bodies, block], contacts: [...next.contacts, ...contacts] };
      if (next.asks.length === 0) next = { ...next, asks: [Math.abs(sup.angleDeg ?? 0)>1e-9 ? makeAsk('end_of_support') : makeAsk('at_time', { t: 2 })] };
      created = block.id;
    }
    if (created) {
      next.rev = scene.rev + 1;
      edit.apply(next);
      dispatch({ type: 'select', id: created });
      dispatch({ type: 'tool', tool: 'select' });
    }
  }

  function finishPolygon() {
    if (!validPolygon(polygon)) {
      dispatch({type:'notice',text:'多边形需要至少三个顶点，且不能自交。'});
      return;
    }
    const shape={kind:'polygon' as const,vertices:polygon};
    const f=makeField(polygonKind,shapeCenter(shape,polygon[0]),shape);
    f.name+=` ${sceneFields.length+1}`;
    edit.apply({...scene,fields:[...sceneFields,f],rev:scene.rev+1});
    dispatch({type:'select',id:f.id});
    dispatch({type:'tool',tool:'select'});
  }

  function onPointerDown(e: React.PointerEvent) {
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* 某些浏览器对非活动指针抛错，不影响拖拽逻辑 */
    }
    const p = local(e);
    if (store.tool === 'pan' || e.button === 1) {
      drag.current = { kind: 'pan', startX: p.x, startY: p.y, cam: { ...cam } };
      return;
    }
    const world = s2w(p);
    if (store.tool === 'measure') {
      dispatch({ type: 'measure', point: snapPoint(world, store.snap) });
      return;
    }
    if (store.tool==='field_polygon') {
      if (polygon.length>=3 && dist(p,w2s(polygon[0]))<11) finishPolygon();
      else setPolygon([...polygon,snapPoint(world,store.snap)]);
      return;
    }
    if (['block', 'ball', 'rope', 'rod', 'incline'].includes(store.tool) || Object.hasOwn(FIELD_LABELS,store.tool)) {
      createAt(world);
      return;
    }
    const node=e.target as Element;
    const fieldTarget=node.closest('[data-field]');
    const field=sceneFields.find(f=>f.id===fieldTarget?.getAttribute('data-field'));
    const fieldHandle=fieldTarget?.getAttribute('data-field-handle')??'move';
    const link=links.find(l=>l.id===node.closest('[data-link]')?.getAttribute('data-link'));
    const hit: Drag | null = (field && fieldHandle !== 'move' ? {kind:'field',id:field.id,handle:fieldHandle,start:world,original:field} : null)
      ?? hitTest(p) ?? (link ? {kind:'link',id:link.id,start:world,original:link}
        : field
          ? {kind:'field',id:field.id,handle:fieldHandle,start:world,original:field} : null);
    if (!hit) {
      dispatch({ type: 'select', id: null });
      drag.current = { kind: 'pan', startX: p.x, startY: p.y, cam: { ...cam } };
      return;
    }
    if (hit.kind !== 'pan') dispatch({ type: 'select', id: hit.id });
    if (hit.kind !== 'pan') edit.begin();
    drag.current = hit;
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = local(e);
    if (d.kind === 'pan') {
      dispatch({ type: 'camera', camera: { ...d.cam, ox: d.cam.ox + (p.x - d.startX), oy: d.cam.oy + (p.y - d.startY) } });
      return;
    }
    const world = snapPoint(s2w(p), store.snap);
    let next = scene;
    if(d.kind==='field'){
      const f=d.original, delta={x:world.x-d.start.x,y:world.y-d.start.y};
      let updated={...f};
      if(d.handle==='source'||f.shape.kind==='global') updated.position={x:f.position.x+delta.x,y:f.position.y+delta.y};
      else if(d.handle==='radius'&&f.shape.kind==='circle') updated.shape={...f.shape,radius:Math.max(0.001,dist(world,f.shape.center))};
      else if(d.handle.startsWith('corner-')&&f.shape.kind==='rect'){
        const opposite=shapeVertices(f.shape)[(Number(d.handle.slice(7))+2)%4];
        updated.shape={kind:'rect',center:{x:(world.x+opposite.x)/2,y:(world.y+opposite.y)/2},width:Math.max(.001,Math.abs(world.x-opposite.x)),height:Math.max(.001,Math.abs(world.y-opposite.y))};
      } else if(d.handle.startsWith('vertex-')&&f.shape.kind==='polygon'){
        const vertices=f.shape.vertices.map((v,i)=>i===Number(d.handle.slice(7))?world:v);
        if(!validPolygon(vertices)) return;
        updated.shape={kind:'polygon',vertices};
      } else {
        updated.shape=translateShape(f.shape,delta);
        if(hasGradient(f)) updated.position={x:f.position.x+delta.x,y:f.position.y+delta.y};
      }
      next={...scene,fields:sceneFields.map(item=>item.id===d.id?updated:item),rev:scene.rev+1};
    } else if(d.kind==='link'){
      const anchor={x:d.original.anchor.x+world.x-d.start.x,y:d.original.anchor.y+world.y-d.start.y};
      next={...scene,links:links.map(l=>l.id===d.id?{...l,anchor}:l),rev:scene.rev+1};
    } else if (d.kind === 'body') {
      const body = scene.bodies.find((b) => b.id === d.id)!;
      if (body.attach) {
        const current = scene.supports.find((s) => s.id === body.attach!.support)!;
        const sup = nearestSupport(scene.supports, world, 1.5) ?? current;
        const s = snapValue(projectToSupport(sup, world), store.snap);
        if (sup.id !== body.attach.support) {
          next = withField(next, `bodies.${d.id}.attach.support`, sup.id);
          if (!next.contacts.some((c) => c.body === d.id && c.support === sup.id)) {
            next = { ...next, contacts: [...next.contacts, makeContact(d.id, sup.id, 0.4, 0.3)] };
          }
        }
        next = withField(next, `bodies.${d.id}.attach.s`, s);
      } else {
        next = withField(next, `bodies.${d.id}.pos`, world);
      }
    } else if (d.kind === 'support') {
      next = withField(next, `supports.${d.id}.a`, snapPoint({ x: d.origA.x + world.x - d.start.x, y: d.origA.y + world.y - d.start.y }, store.snap));
    } else if (d.kind === 'endpoint') {
      const sup = scene.supports.find((s) => s.id === d.id)!;
      if (d.end === 'a') {
        next = withField(next, `supports.${d.id}.a`, world);
      } else {
        const dx = world.x - sup.a.x;
        const dy = world.y - sup.a.y;
        const oldLen = supportLength(sup);
        const len = Math.max(0.2, Math.hypot(dx, dy));
        const newLen = Number(len.toFixed(3));
        next = withField(next, `supports.${d.id}.length`, newLen);
        next = withField(next, `supports.${d.id}.angleDeg`, Number(((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(2)));
        for (const body of scene.bodies) {
          if (body.attach?.support !== d.id || body.attach.s === null) continue;
          if (body.attach.s >= oldLen - 1e-6) next = withField(next, `bodies.${body.id}.attach.s`, newLen);
          else if (body.attach.s > newLen) next = withField(next, `bodies.${body.id}.attach.s`, newLen);
        }
      }
    } else if (d.kind === 'velocity') {
      const body = scene.bodies.find((b) => b.id === d.id)!;
      const base = bodyScreen(body);
      if (!base) return;
      if (body.attach) {
        const sup = scene.supports.find((s) => s.id === body.attach!.support)!;
        const dir = supportDir(sup);
        const u = ((p.x - base.x) * dir.x - (p.y - base.y) * dir.y) / VSCALE;
        next = withField(next, `bodies.${d.id}.vel`, { x: Number((u * dir.x).toFixed(3)), y: Number((u * dir.y).toFixed(3)) });
      } else {
        next = withField(next, `bodies.${d.id}.vel`, { x: Number(((p.x - base.x) / VSCALE).toFixed(3)), y: Number(((base.y - p.y) / VSCALE).toFixed(3)) });
      }
    }
    if (next !== scene) edit.transient(next);
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (d && d.kind !== 'pan') edit.end();
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const p = local(e);
    const before = s2w(p);
    const scale = Math.min(400, Math.max(6, cam.scale * Math.exp(-e.deltaY * 0.0012)));
    const nextCam = { scale, ox: p.x - before.x * scale, oy: p.y + before.y * scale };
    dispatch({ type: 'camera', camera: nextCam });
  }

  let dotStep = store.snap.step;
  while (dotStep * cam.scale < 10) dotStep *= 2;
  const dotPitch = dotStep * cam.scale;
  const dotX = ((cam.ox % dotPitch) + dotPitch) % dotPitch;
  const dotY = ((cam.oy % dotPitch) + dotPitch) % dotPitch;
  const grid: React.ReactNode[] = [];
  const topLeft = s2w({ x: 0, y: 0 });
  const bottomRight = s2w({ x: size.w, y: size.h });
  let gridStep = 1;
  while (gridStep * cam.scale < 20) gridStep *= 2;
  for (let i = Math.floor(topLeft.x / gridStep); i <= Math.ceil(bottomRight.x / gridStep); i++) {
    const a = w2s({ x: i * gridStep, y: 0 });
    grid.push(<line key={`gx${i}`} x1={a.x} y1={0} x2={a.x} y2={size.h} className={i === 0 ? 'axis' : 'grid'} />);
  }
  for (let i = Math.floor(bottomRight.y / gridStep); i <= Math.ceil(topLeft.y / gridStep); i++) {
    const a = w2s({ x: 0, y: i * gridStep });
    grid.push(<line key={`gy${i}`} x1={0} y1={a.y} x2={size.w} y2={a.y} className={i === 0 ? 'axis' : 'grid'} />);
  }

  const trajectories = solution ? (solution.bodyTracks??[{bodyId:scene.bodies[0]?.id,samples:solution.samples}])
    .map(item=>({id:item.bodyId,points:item.samples.map(w2s)})) : [];
  const moving = solution && (store.playback.t > 0 || store.playback.mode === 'playing') ? solution.evalAt(store.playback.t) : null;
  const motions=moving&&solution?(solution.bodyTracks??[{bodyId:scene.bodies[0].id,evalAt:solution.evalAt}]).flatMap((item,index)=>{
    const body=scene.bodies.find(b=>b.id===item.bodyId);
    if(!body)return [];
    const sample=item.evalAt(store.playback.t);
    return [{body,sample,point:w2s(sample),index}];
  }):[];
  const activeFields=((moving ?? solution?.evalAt(0))?.fieldIds??[])
    .map(id=>sceneFields.find(f=>f.id===id)?.name).filter(Boolean);
  const measurement = store.measure.a && store.measure.b ? {
    a: w2s(store.measure.a), b: w2s(store.measure.b),
    text: `${dist(store.measure.a, store.measure.b).toFixed(3)} m`,
  } : null;
  const joints: Vec2[] = [];
  for (let i = 0; i < scene.supports.length; i++) {
    for (let j = i + 1; j < scene.supports.length; j++) {
      const endsA = [scene.supports[i].a, supportEnd(scene.supports[i])];
      const endsB = [scene.supports[j].a, supportEnd(scene.supports[j])];
      for (const a of endsA) for (const b of endsB) {
        if (dist(a, b) <= 0.02 && !joints.some((p) => dist(p, a) <= 0.02)) joints.push(a);
      }
    }
  }

  const mid = (a: Vec2, b: Vec2) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const supports = scene.supports.map((sup) => ({
    sup, a: w2s(sup.a), b: w2s(supportEnd(sup)), selected: store.selection === sup.id,
    text: `${sup.name} θ=${sup.angleDeg ?? '?'}° L=${sup.length ?? '?'} m`,
  }));
  const bodies = scene.bodies.flatMap((body) => {
    const p = bodyScreen(body);
    if (!p) return [];
    const sup = body.attach ? scene.supports.find((s) => s.id === body.attach!.support) : null;
    const selected = store.selection === body.id;
    const tip = selected || store.tool === 'velocity' ? velocityTip(body) : null;
    return [{ body, p, selected, tip, angle: -(sup?.angleDeg ?? 0) }];
  });
  const eventGroups: Array<{ key: string; p: Vec2; texts: string[] }> = [];
  solution?.events.forEach((ev) => {
    const p = w2s(solution.evalAt(ev.t));
    const text = `${ev.label} t=${ev.t.toFixed(2)} s`;
    const group = eventGroups.find((g) => dist(g.p, p) < 8);
    if (group) group.texts.push(text);
    else eventGroups.push({ key: `${ev.kind}-${ev.t}`, p, texts: [text] });
  });

  const jointPoints = joints.map(w2s);
  const labels: CanvasLabel[] = [];
  const obstacles = jointPoints.map((p) => labelObstacle(p, 6));
  for(const f of sceneFields) {
    const p=w2s(shapeCenter(f.shape,f.position));
    obstacles.push(labelObstacle(p,11));
    labels.push({id:f.id,at:p,text:f.name,tone:'object',priority:store.selection===f.id?4:0});
  }
  for (const { sup, a, b, selected, text } of supports) {
    labels.push({ id: sup.id, at: mid(a, b), text, tone: 'object', priority: selected ? 4 : 0 });
    if (selected) obstacles.push(labelObstacle(a, 8), labelObstacle(b, 8));
  }
  for (const { body, p, selected, tip } of bodies) {
    labels.push({ id: body.id, at: p, text: body.name+(moving?'（初始）':''), tone: 'object', priority: selected ? 4 : 1 });
    obstacles.push(labelObstacle(p, body.kind === 'block' ? 24 : bodyRadius(body)+1));
    if (tip) {
      obstacles.push(labelObstacle(tip, 8));
      labels.push({ id: `velocity-${body.id}`, at: tip, text: 'v', tone: 'velocity', priority: 3 });
    }
  }
  for (const { key, p, texts } of eventGroups) {
    obstacles.push(labelObstacle(p, 7));
    labels.push({ id: `event-${key}`, at: p, text: texts.length > 1 ? `${texts[0]} · +${texts.length - 1}` : texts[0], tone: 'event', priority: 2 });
  }
  for(const {body,sample,point} of motions) {
    obstacles.push(labelObstacle(point, body.kind === 'block' ? 24 : bodyRadius(body)+1));
    labels.push({ id: 'moving-'+body.id, at: point, text: body.name+' · t='+fmt(sample.t,4)+' s', tone: 'moving', priority: 5 });
  }
  if (measurement) {
    labels.push({ id: 'measurement', at: mid(measurement.a, measurement.b), text: measurement.text, tone: 'measure', priority: 5 });
  }

  return (
    <div className="canvas-wrap">
      <div className="canvas-area" ref={ref}>
      <svg
        width={size.w}
        height={size.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        className={`tool-${store.tool}`}
      >
        <defs>
          <pattern id="snap-grid" width={dotPitch} height={dotPitch} patternUnits="userSpaceOnUse">
            <circle cx={dotX} cy={dotY} r={1.15} className="grid-dot" />
          </pattern>
        </defs>
        <rect width={size.w} height={size.h} fill="url(#snap-grid)" />
        {grid}
        <FieldLayer fields={visibleFields} links={links} selection={store.selection} toScreen={w2s} draft={polygon} draftColor={FIELD_COLORS[polygonKind]}
          linkBody={(link)=>{
            const b=scene.bodies.find(b=>b.id===link.bodyId);
            if(!b)return null;
            if(moving)return moving;
            const p=bodyScreen(b);
            return p?s2w(p):null;
          }} />
        {trajectories.filter(item=>item.points.length>1).map((item,index)=>(
          <polyline key={item.id} data-trajectory-body={item.id} points={item.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} className="trajectory" style={index?{stroke:'#0891b2'}:undefined} />
        ))}
        {supports.map(({ sup, a, b, selected, text }) => {
          return (
            <g key={sup.id} className={selected ? 'selected' : ''}>
              <title>{text}</title>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="support-line" />
              {Array.from({ length: Math.floor(supportLength(sup) * 2) }, (_, i) => {
                const s = (i + 0.5) / 2;
                const d = supportDir(sup);
                const p = w2s({ x: sup.a.x + d.x * s, y: sup.a.y + d.y * s });
                return <line key={i} x1={p.x} y1={p.y} x2={p.x - d.y * 6} y2={p.y - d.x * 6} className="hatch" />;
              })}
              {selected && (
                <>
                  <circle cx={a.x} cy={a.y} r={7} className="handle" />
                  <circle cx={b.x} cy={b.y} r={7} className="handle" />
                </>
              )}
            </g>
          );
        })}
        {jointPoints.map((p, i) => <circle key={`joint${i}`} cx={p.x} cy={p.y} r={5} className="joint-marker" />)}
        {bodies.map(({ body, p, selected, tip, angle }) => {
          return (
            <g key={body.id} className={selected ? 'selected' : ''}>
              <title>{body.name}</title>
              {body.kind === 'boat' && (() => {
                const w = body.width ?? 0;
                const x0 = body.pos.x ?? 0;
                const y0 = body.pos.y ?? 0;
                const maxX = solution ? Math.max(x0 + 30, ...solution.samples.map((st) => st.x)) : x0 + 30;
                const na = w2s({ x: x0 - 6, y: y0 });
                const nb = w2s({ x: maxX + 6, y: y0 });
                const fa = w2s({ x: x0 - 6, y: y0 + w });
                const fb = w2s({ x: maxX + 6, y: y0 + w });
                const fx = body.flow?.x ?? 0;
                const fy = body.flow?.y ?? 0;
                const rx = (body.vel.x ?? 0) + fx;
                const ry = (body.vel.y ?? 0) + fy;
                return (
                  <>
                    <line x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} className="river-bank"><title>近岸</title></line>
                    <line x1={fa.x} y1={fa.y} x2={fb.x} y2={fb.y} className="river-bank"><title>对岸（河宽 d={w} m）</title></line>
                    {selected && (
                      <>
                        <line x1={p.x} y1={p.y} x2={p.x + fx * VSCALE} y2={p.y - fy * VSCALE} className="flow-arrow"><title>水流速度</title></line>
                        <line x1={p.x} y1={p.y} x2={p.x + rx * VSCALE} y2={p.y - ry * VSCALE} className="resultant-arrow"><title>合速度</title></line>
                      </>
                    )}
                  </>
                );
              })()}
              {body.kind === 'circular' && (() => {
                const r = (body.radius ?? 0) * cam.scale;
                const th = body.phase ?? 0;
                const start = w2s({ x: (body.pos.x ?? 0) + (body.radius ?? 0) * Math.cos(th), y: (body.pos.y ?? 0) + (body.radius ?? 0) * Math.sin(th) });
                return (
                  <>
                    <circle cx={p.x} cy={p.y} r={r} className="circle-track" />
                    <circle cx={p.x} cy={p.y} r={3} className="circle-center" />
                    <circle cx={start.x} cy={start.y} r={10} className={moving ? 'initial-body' : 'body-circular'} />
                  </>
                );
              })()}
              {tip && body.kind !== 'circular' && (
                <>
                  <line x1={p.x} y1={p.y} x2={tip.x} y2={tip.y} className="velocity-arrow" />
                  <circle cx={tip.x} cy={tip.y} r={7} className="handle velocity"><title>初速度</title></circle>
                </>
              )}
              {body.kind === 'block' && (
                <rect x={-16} y={-16} width={32} height={32} transform={`translate(${p.x} ${p.y}) rotate(${angle})`} className={moving ? 'initial-body' : 'body-block'} />
              )}
              {(body.kind === 'projectile' || body.kind === 'ball') && (
                <circle cx={p.x} cy={p.y} r={bodyRadius(body)} className={moving ? 'initial-body' : 'body-projectile'} />
              )}
              {body.kind === 'boat' && (
                <path transform={`translate(${p.x} ${p.y})`} d="M -12 6 L 12 6 L 7 -6 L -7 -6 Z" className={moving ? 'initial-body' : 'body-boat'} />
              )}
            </g>
          );
        })}
        {motions.map(({body,sample,point,index}) => (
          <g key={body.id} className="moving-body" data-moving-body={body.id} pointerEvents="none">
            <title>{body.name+' · t='+fmt(sample.t,4)+' s'}</title>
            {body.kind === 'block' ? (
              <rect x={-16} y={-16} width={32} height={32}
                transform={`translate(${point.x} ${point.y}) rotate(${track ? -(trackSegmentAt(track, sample.s, sample.u).support.angleDeg ?? 0) : 0})`}
                className="body-block" />
            ) : body.kind === 'boat' ? (
              <path transform={`translate(${point.x} ${point.y})`} d="M -12 6 L 12 6 L 7 -6 L -7 -6 Z" className="body-boat" />
            ) : (
              <circle cx={point.x} cy={point.y} r={body.kind === 'circular' ? 10 : bodyRadius(body)} className={body.kind === 'circular' ? 'body-circular' : 'body-projectile'} style={index?{fill:'#67e8f9',stroke:'#0e7490'}:undefined} />
            )}
          </g>
        ))}
        {eventGroups.map(({ key, p, texts }) => (
          <rect key={key} x={p.x - 4} y={p.y - 4} width={8} height={8} transform={`rotate(45 ${p.x} ${p.y})`} className="event-marker">
            <title>{texts.join('\n')}</title>
          </rect>
        ))}
        {measurement && (
          <line x1={measurement.a.x} y1={measurement.a.y} x2={measurement.b.x} y2={measurement.b.y} className="measure-line">
            <title>{measurement.text}（仅测量，不影响物理）</title>
          </line>
        )}
        <CanvasLabels labels={labels} obstacles={obstacles} size={size} />
      </svg>
      </div>
      <div className="canvas-status">
        <span>{store.snap.enabled ? '吸附' : '不吸附'} {store.snap.step} m · 点阵 {dotStep} m · 滚轮缩放 · 空白处拖动平移</span>
        {store.notice
          ? <span className="notice">{store.notice}</span>
          : <span>{store.tool === 'measure' ? '测量：点击两点' : store.tool === 'select' ? '选中对象后可拖动控制柄' : store.tool === 'block' ? '物块：点击已有斜面放置' : store.tool === 'field_polygon' ? '绘制多边形场区' : `当前工具：${store.tool}`}</span>}
        {activeFields.length>1&&<span>合场：{activeFields.join(' + ')}</span>}
      </div>
      {store.tool==='field_polygon' && <div className="polygon-actions">
        <label>场类型 <select value={polygonKind} onChange={e=>setPolygonKind(e.target.value as FieldKind)}>
          {Object.entries(FIELD_LABELS).map(([kind,label])=><option key={kind} value={kind}>{label}</option>)}
        </select></label>
        <span>点击画布添加顶点</span>
        <button className="mini" disabled={polygon.length<3} onClick={finishPolygon}>闭合场区</button>
        <button className="mini" onClick={()=>{setPolygon([]);dispatch({type:'tool',tool:'select'});}}>取消</button>
      </div>}
    </div>
  );
}
