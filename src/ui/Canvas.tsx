import { useEffect, useRef, useState } from 'react';
import type { Body, Scene, Solution, Support, Vec2 } from '../model/types';
import { bodyWorld, projectToSupport, supportDir, supportEnd, supportLength } from '../model/geometry';
import { makeAsk, makeBlock, makeContact, makeProjectile, makeSupport } from '../model/factory';
import { setAt } from '../model/paths';
import { snapPoint, snapValue } from '../model/snap';
import type { Action, Camera, Store } from '../state/store';

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
  | { kind: 'velocity'; id: string };

const VSCALE = 12;

export function Canvas({ store, dispatch, solution, edit }: { store: Store; dispatch: (a: Action) => void; solution: Solution | null; edit: Edit }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [size, setSize] = useState({ w: 900, h: 520 });
  const scene = store.present;
  const cam = store.camera;

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
    return p ? w2s(p) : null;
  }

  function velocityTip(body: Body): Vec2 | null {
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
      if (bp && dist(p, bp) < 20) return { kind: 'body', id: body.id };
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
    if (store.tool === 'projectile') {
      const b = makeProjectile(Number(world.x.toFixed(2)), Number(world.y.toFixed(2)), 5, 5);
      next = { ...next, bodies: [...next.bodies, b] };
      created = b.id;
    } else if (store.tool === 'horizontal' || store.tool === 'incline') {
      const sup = makeSupport(store.tool === 'incline' ? 'incline' : 'horizontal', { x: Number(world.x.toFixed(2)), y: Number(world.y.toFixed(2)) }, 5, store.tool === 'incline' ? 30 : 0);
      next = { ...next, supports: [...next.supports, sup] };
      created = sup.id;
    } else if (store.tool === 'block') {
      let sup = next.supports[0];
      if (!sup) {
        sup = makeSupport('horizontal', { x: world.x - 5, y: world.y }, 10, 0);
        next = { ...next, supports: [sup] };
      }
      const s = snapValue(projectToSupport(sup, world), store.snap);
      const block = makeBlock(sup.id, s);
      const contact = makeContact(block.id, sup.id, 0.4, 0.3);
      next = { ...next, bodies: [...next.bodies, block], contacts: [...next.contacts, contact] };
      if (next.asks.length === 0) next = { ...next, asks: [makeAsk(sup.kind === 'incline' ? 'end_of_support' : 'at_time', sup.kind === 'incline' ? {} : { t: 2 })] };
      created = block.id;
    }
    if (created) {
      next.rev = scene.rev + 1;
      edit.apply(next);
      dispatch({ type: 'select', id: created });
      dispatch({ type: 'tool', tool: 'select' });
    }
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
    if (['block', 'projectile', 'horizontal', 'incline'].includes(store.tool)) {
      createAt(world);
      return;
    }
    const hit = hitTest(p);
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
    if (d.kind === 'body') {
      const body = scene.bodies.find((b) => b.id === d.id)!;
      if (body.attach) {
        const sup = scene.supports.find((s) => s.id === body.attach!.support)!;
        next = setAt(next, `bodies.${d.id}.attach.s`, snapValue(projectToSupport(sup, world), store.snap));
      } else {
        next = setAt(next, `bodies.${d.id}.pos`, world);
      }
    } else if (d.kind === 'support') {
      next = setAt(next, `supports.${d.id}.a`, snapPoint({ x: d.origA.x + world.x - d.start.x, y: d.origA.y + world.y - d.start.y }, store.snap));
    } else if (d.kind === 'endpoint') {
      const sup = scene.supports.find((s) => s.id === d.id)!;
      if (d.end === 'a') {
        next = setAt(next, `supports.${d.id}.a`, world);
      } else {
        const dx = world.x - sup.a.x;
        const dy = world.y - sup.a.y;
        const len = Math.max(0.2, Math.hypot(dx, dy));
        next = setAt(next, `supports.${d.id}.length`, Number(len.toFixed(3)));
        if (sup.kind === 'incline') next = setAt(next, `supports.${d.id}.angleDeg`, Number(((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(2)));
      }
    } else if (d.kind === 'velocity') {
      const body = scene.bodies.find((b) => b.id === d.id)!;
      const base = bodyScreen(body);
      if (!base) return;
      if (body.attach) {
        const sup = scene.supports.find((s) => s.id === body.attach!.support)!;
        const dir = supportDir(sup);
        const u = ((p.x - base.x) * dir.x - (p.y - base.y) * dir.y) / VSCALE;
        next = setAt(next, `bodies.${d.id}.vel`, { x: Number((u * dir.x).toFixed(3)), y: Number((u * dir.y).toFixed(3)) });
      } else {
        next = setAt(next, `bodies.${d.id}.vel`, { x: Number(((p.x - base.x) / VSCALE).toFixed(3)), y: Number(((base.y - p.y) / VSCALE).toFixed(3)) });
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
  for (let x = Math.floor(topLeft.x); x <= Math.ceil(bottomRight.x); x++) {
    const a = w2s({ x, y: 0 });
    grid.push(<line key={`gx${x}`} x1={a.x} y1={0} x2={a.x} y2={size.h} className={x === 0 ? 'axis' : 'grid'} />);
  }
  for (let y = Math.floor(bottomRight.y); y <= Math.ceil(topLeft.y); y++) {
    const a = w2s({ x: 0, y });
    grid.push(<line key={`gy${y}`} x1={0} y1={a.y} x2={size.w} y2={a.y} className={y === 0 ? 'axis' : 'grid'} />);
  }

  const trajectory = solution ? solution.samples.map((st) => w2s({ x: st.x, y: st.y })) : [];
  const moving = solution && (store.playback.t > 0 || store.playback.mode === 'playing') ? solution.evalAt(store.playback.t) : null;

  return (
    <div className="canvas-wrap" ref={ref}>
      <svg
        width={size.w}
        height={size.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
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
        {trajectory.length > 1 && (
          <polyline points={trajectory.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} className="trajectory" />
        )}
        {solution?.events.map((ev) => {
          const st = solution.evalAt(ev.t);
          const p = w2s(st);
          return (
            <g key={`${ev.kind}${ev.t}`}>
              <rect x={p.x - 4} y={p.y - 4} width={8} height={8} transform={`rotate(45 ${p.x} ${p.y})`} className="event-marker" />
              <text x={p.x + 8} y={p.y - 8} className="event-label">{ev.label} t={ev.t.toFixed(2)}s</text>
            </g>
          );
        })}
        {scene.supports.map((sup: Support) => {
          const a = w2s(sup.a);
          const b = w2s(supportEnd(sup));
          const selected = store.selection === sup.id;
          return (
            <g key={sup.id} className={selected ? 'selected' : ''}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="support-line" />
              {Array.from({ length: Math.floor(supportLength(sup) * 2) }, (_, i) => {
                const s = (i + 0.5) / 2;
                const d = supportDir(sup);
                const p = w2s({ x: sup.a.x + d.x * s, y: sup.a.y + d.y * s });
                return <line key={i} x1={p.x} y1={p.y} x2={p.x - d.y * 6} y2={p.y - d.x * 6} className="hatch" />;
              })}
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 12} className="obj-label">
                {sup.name}{sup.kind === 'incline' ? ` θ=${sup.angleDeg ?? '?'}°` : ''} L={sup.length ?? '?'}m
              </text>
              {selected && (
                <>
                  <circle cx={a.x} cy={a.y} r={7} className="handle" />
                  <circle cx={b.x} cy={b.y} r={7} className="handle" />
                </>
              )}
            </g>
          );
        })}
        {scene.bodies.map((body: Body) => {
          const p = bodyScreen(body);
          if (!p) return null;
          const sup = body.attach ? scene.supports.find((s) => s.id === body.attach!.support) : null;
          const angle = sup ? -(sup.angleDeg ?? 0) : 0;
          const selected = store.selection === body.id;
          const tip = velocityTip(body);
          return (
            <g key={body.id} className={selected ? 'selected' : ''}>
              {(selected || store.tool === 'velocity') && tip && (
                <>
                  <line x1={p.x} y1={p.y} x2={tip.x} y2={tip.y} className="velocity-arrow" />
                  <circle cx={tip.x} cy={tip.y} r={7} className="handle velocity" />
                  <text x={tip.x + 10} y={tip.y} className="obj-label">v</text>
                </>
              )}
              {body.kind === 'block' ? (
                <rect x={-16} y={-16} width={32} height={32} transform={`translate(${p.x} ${p.y}) rotate(${angle})`} className="body-block" />
              ) : (
                <circle cx={p.x} cy={p.y} r={12} className="body-projectile" />
              )}
              <text x={p.x + 20} y={p.y + 22} className="obj-label">{body.name}</text>
            </g>
          );
        })}
        {moving && (
          <g>
            <circle cx={w2s(moving).x} cy={w2s(moving).y} r={9} className="moving-marker" />
            <text x={w2s(moving).x + 12} y={w2s(moving).y - 12} className="moving-label">
              t={moving.t.toFixed(2)}s
            </text>
          </g>
        )}
        {store.measure.a && store.measure.b && (
          <g>
            <line x1={w2s(store.measure.a).x} y1={w2s(store.measure.a).y} x2={w2s(store.measure.b).x} y2={w2s(store.measure.b).y} className="measure-line" />
            <text x={(w2s(store.measure.a).x + w2s(store.measure.b).x) / 2} y={(w2s(store.measure.a).y + w2s(store.measure.b).y) / 2 - 8} className="obj-label">
              {Math.hypot(store.measure.a.x - store.measure.b.x, store.measure.a.y - store.measure.b.y).toFixed(3)} m（仅测量，不影响物理）
            </text>
          </g>
        )}
      </svg>
      <div className="canvas-status">
        <span>{store.snap.enabled ? '吸附' : '不吸附'} {store.snap.step} m · 点阵 {dotStep} m · 滚轮缩放 · 空白处拖动平移</span>
        <span>{store.tool === 'measure' ? '测量：点击两点' : store.tool === 'select' ? '选中对象后可拖动控制柄' : `当前工具：${store.tool}`}</span>
      </div>
    </div>
  );
}
