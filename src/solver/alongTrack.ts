import { EPS, positiveRoots, quadraticRoots, type StageEval } from './common';

export type Phase = { a: number; label: string; note?: string; static?: boolean };

export type TrackEvent = { kind: 'rest' | 'end_of_support' | 'junction'; t: number; s: number; label: string };

/**
 * 沿支撑面的一维多段运动：每段匀变速，段间由"速度归零"或"到达端点"切换。
 * 到达轨道外端点即终止；内部连接点只切换支撑面，不截断运动。
 */
export function runTrack(opts: {
  s0: number;
  u0: number;
  length: number;
  junctions?: number[];
  decide: (state: { s: number; u: number }) => Phase;
  window: number;
}): { stages: StageEval[]; tEnd: number; terminated: boolean; events: TrackEvent[] } {
  const { s0, u0, length: L, decide, window } = opts;
  const junctions = opts.junctions ?? [];
  const stages: StageEval[] = [];
  const events: TrackEvent[] = [];
  let t = 0;
  let s = s0;
  let u = u0;
  let terminated = false;

  for (let iter = 0; iter < 64 && t < window - EPS; iter++) {
    const phase = decide({ s, u });
    const a = phase.static ? 0 : phase.a;
    const candidates: Array<{ dt: number; kind: 'rest' | 'end'; target?: number }> = [];

    if (!phase.static) {
      if (Math.abs(a) > EPS && Math.abs(u) > EPS && -u / a > EPS) candidates.push({ dt: -u / a, kind: 'rest' });
      for (const target of [0, ...junctions, L]) {
        const roots = positiveRoots(quadraticRoots(0.5 * a, u, s - target));
        if (roots.length) candidates.push({ dt: roots[0], kind: 'end', target });
      }
    }
    candidates.sort((p, q) => p.dt - q.dt);
    const hit = candidates[0];
    const dur = hit ? Math.min(hit.dt, window - t) : window - t;
    const start = { s, u };
    stages.push({
      stage: { label: phase.label, t0: t, t1: t + dur, note: phase.note },
      s0: start.s, u0: start.u, a,
      eval: (dt: number) => ({ s: start.s + start.u * dt + 0.5 * a * dt * dt, u: start.u + a * dt }),
    });
    s = start.s + start.u * dur + 0.5 * a * dur * dur;
    u = start.u + a * dur;
    t += dur;

    if (hit && Math.abs(hit.dt - dur) < EPS) {
      if (hit.kind === 'end') {
        s = hit.target!;
        if (s <= EPS || s >= L - EPS) {
          terminated = true;
          events.push({ kind: 'end_of_support', t, s, label: s <= EPS ? '到达轨道起点端' : '到达轨道终点端' });
          break;
        }
        events.push({ kind: 'junction', t, s, label: '经过支撑面连接点' });
        continue;
      }
      events.push({ kind: 'rest', t, s, label: '速度为零' });
      u = 0;
    }
    if (!hit || phase.static) break;
  }

  return { stages, tEnd: t, terminated, events };
}
