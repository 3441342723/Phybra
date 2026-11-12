import type { Sample, Stage } from '../model/types';
import { fmt } from '../model/units';

export const EPS = 1e-9;

export function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) < EPS) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < -EPS) return [];
  const sq = Math.sqrt(Math.max(0, disc));
  const roots = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
  return roots.filter((r) => Number.isFinite(r)).sort((p, q) => p - q);
}

export function positiveRoots(roots: number[], tMax = Infinity): number[] {
  return roots.filter((r) => r > EPS && r <= tMax + EPS);
}

export function latexNum(v: number): string {
  return fmt(v, 4);
}

export type StageEval = {
  stage: Stage;
  s0: number;
  u0: number;
  a: number;
  eval: (dt: number) => { s: number; u: number };
};

/** 多段匀变速 → 统一的采样与解析求值；world 负责把沿面量换算成 x/y/vx/vy */
export function buildTrack(
  stageEvals: StageEval[],
  tEnd: number,
  world: (s: number, u: number) => { x: number; y: number; vx: number; vy: number },
): { samples: Sample[]; evalAt: (t: number) => Sample; stages: Stage[] } {
  const clampT = (t: number) => Math.min(Math.max(t, 0), tEnd);
  const evalAt = (time: number): Sample => {
    const t = clampT(time);
    const found = stageEvals.find((se) => t <= se.stage.t1 + EPS) ?? stageEvals[stageEvals.length - 1];
    const dt = Math.min(Math.max(t - found.stage.t0, 0), found.stage.t1 - found.stage.t0);
    const { s, u } = found.eval(dt);
    const w = world(s, u);
    return { t, s, u, ...w };
  };
  const samples: Sample[] = [];
  for (const se of stageEvals) {
    const dur = se.stage.t1 - se.stage.t0;
    const n = Math.max(24, Math.min(400, Math.ceil(dur * 60)));
    for (let i = 0; i <= n; i++) {
      if (se.stage.t0 > 0 && i === 0) continue;
      samples.push(evalAt(se.stage.t0 + (dur * i) / n));
    }
  }
  if (samples.length === 0 || Math.abs(samples[samples.length - 1].t - tEnd) > EPS) samples.push(evalAt(tEnd));
  return { samples, evalAt, stages: stageEvals.map((se) => se.stage) };
}

export function dedupeNumbers(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) if (!out.some((o) => Math.abs(o - v) < 1e-7)) out.push(v);
  return out.sort((a, b) => a - b);
}
