import { EPS, quadraticRoots, type StageEval } from './common';

export type Phase = { a: number; label: string; note?: string; static?: boolean };

export type TrackEvent = { kind: 'rest' | 'end_of_support' | 'junction'; t: number; s: number; label: string };
type TrackOutcome = 'end_of_support' | 'stationary' | 'incomplete';

export const TRACK_INCOMPLETE_NOTE = '分段求解未完成；后续运动尚未确定';

export function trackEndNote(outcome: TrackOutcome, events: TrackEvent[]): string {
  if (outcome !== 'stationary') return TRACK_INCOMPLETE_NOTE;
  return events.some((e) => e.kind === 'rest')
    ? '物体在到达端点前停下并保持静止'
    : '物体保持静止，不会到达端点';
}

/**
 * 沿支撑面的一维多段运动：每段匀变速，段间由"速度归零"或"到达端点"切换。
 * 播放截至轨道外端点或持续静止的开始时刻；内部连接点只切换支撑面。
 */
export function runTrack(opts: {
  s0: number;
  u0: number;
  length: number;
  junctions?: number[];
  decide: (state: { s: number; u: number }) => Phase;
}): { stages: StageEval[]; tEnd: number; outcome: TrackOutcome; events: TrackEvent[] } {
  const { s0, u0, length: L, decide } = opts;
  const junctions = opts.junctions ?? [];
  const stages: StageEval[] = [];
  const events: TrackEvent[] = [];
  let t = 0;
  let s = Math.min(L, Math.max(0, s0));
  let u = u0;
  let outcome: TrackOutcome = 'incomplete';

  function append(phase: Phase, a: number, dt: number, target?: number, stops = false) {
    const start = { s, u };
    const end = t + dt;
    const duration = end - t;
    const evalStage = (elapsed: number) => {
      const atEnd = elapsed === duration;
      const time = atEnd ? dt : elapsed;
      return {
        s: atEnd && target !== undefined ? target : start.s + time * (start.u + 0.5 * a * time),
        u: atEnd && stops ? 0 : start.u + a * time,
      };
    };
    stages.push({
      stage: { label: phase.label, t0: t, t1: end, note: phase.note },
      s0: start.s, u0: start.u, a, eval: evalStage,
    });
    ({ s, u } = evalStage(duration));
    t = end;
  }

  function finishAtEnd() {
    events.push({ kind: 'end_of_support', t, s, label: s === 0 ? '到达轨道起点端' : '到达轨道终点端' });
    return 'end_of_support' as const;
  }

  // 限制分段次数，不限制运动时长；预留完整往返一次的段数。
  const maxStages = Math.max(64, 2 * junctions.length + 4);
  const boundaries = [0, ...junctions, L];
  const reverse = [...boundaries].reverse();
  for (let iter = 0; iter < maxStages; iter++) {
    const phase = decide({ s, u });
    const a = phase.static ? 0 : phase.a;
    if (phase.static || (u === 0 && a === 0)) {
      outcome = 'stationary';
      u = 0;
      if (stages.length === 0) append(phase, 0, 0);
      break;
    }

    const direction = Math.sign(u || a);
    if ((s === 0 && direction < 0) || (s === L && direction > 0)) {
      if (stages.length === 0) append(phase, a, 0);
      outcome = finishAtEnd();
      break;
    }

    // 速度归零前运动单调，只需考察前方最近的连接点或端点。
    const target = direction > 0 ? boundaries.find((x) => x > s) : reverse.find((x) => x < s);
    const tBoundary = target === undefined ? Infinity : (quadraticRoots(0.5 * a, u, s - target).find((r) => r > 0) ?? Infinity);
    const tRest = a !== 0 && -u / a > 0 ? -u / a : Infinity;
    const dt = Math.min(tBoundary, tRest);
    if (!Number.isFinite(t + dt) || t + dt === t) {
      if (stages.length === 0) append(phase, a, 0);
      break;
    }
    const sameEvent = Math.abs(tBoundary - tRest) <= Math.max(EPS, Number.EPSILON * 8 * dt);
    const hitBoundary = tBoundary <= tRest || sameEvent;
    const stops = !hitBoundary || sameEvent;
    append(phase, a, dt, hitBoundary ? target : undefined, stops);
    if (stops) events.push({ kind: 'rest', t, s, label: '速度为零' });
    if (hitBoundary && (s === 0 || s === L)) {
      outcome = finishAtEnd();
      break;
    }
    if (hitBoundary) events.push({ kind: 'junction', t, s, label: '经过支撑面连接点' });
  }

  return { stages, tEnd: t, outcome, events };
}
