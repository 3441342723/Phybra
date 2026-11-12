import { baseScene, makeAsk, makeBlock, makeContact, makeProjectile, makeSupport } from '../src/model/factory';
import type { Answer, Scene, Solution } from '../src/model/types';
import { solve } from '../src/solver';

export function ok(result: ReturnType<typeof solve>): Solution {
  if (!result.ok) throw new Error('求解失败: ' + JSON.stringify(result.report.blockers));
  return result.solution;
}

export function answer(sol: Solution, id: string): Answer {
  const a = sol.answers.find((x) => x.id === id);
  if (!a) throw new Error(`缺少答案 ${id}，已有: ${sol.answers.map((x) => x.id).join(',')}`);
  return a;
}

export function close(actual: number | null, expected: number, tol = 1e-6): void {
  if (actual === null || Math.abs(actual - expected) > tol) {
    throw new Error(`期望 ${expected}，实际 ${actual}`);
  }
}

export function projectile(opts: { x?: number; y?: number; vx?: number; vy?: number; g?: number; asks?: Scene['asks'] }): Scene {
  const sc = baseScene('抛体测试');
  sc.gravity = opts.g ?? 10;
  sc.bodies = [makeProjectile(opts.x ?? 0, opts.y ?? 0, opts.vx ?? 0, opts.vy ?? 0)];
  sc.asks = opts.asks ?? [makeAsk('landing'), makeAsk('apex')];
  return sc;
}

export function incline(opts: {
  angle?: number; length?: number; s0?: number | null; u?: number | null;
  mu_s?: number | null; mu_k?: number | null; g?: number; asks?: Scene['asks'];
}): Scene {
  const sc = baseScene('斜面测试');
  sc.gravity = opts.g ?? 10;
  const sup = makeSupport('incline', { x: 0, y: 0 }, opts.length ?? 5, opts.angle ?? 30);
  const block = makeBlock(sup.id, opts.s0 === undefined ? (opts.length ?? 5) : opts.s0);
  const th = ((opts.angle ?? 30) * Math.PI) / 180;
  const u = opts.u === undefined || opts.u === null ? 0 : opts.u;
  block.vel = { x: opts.u === null ? null : u * Math.cos(th), y: opts.u === null ? null : u * Math.sin(th) };
  sc.supports = [sup];
  sc.bodies = [block];
  sc.contacts = [makeContact(block.id, sup.id, opts.mu_s ?? null, opts.mu_k ?? null)];
  sc.asks = opts.asks ?? [makeAsk('end_of_support'), makeAsk('friction_state')];
  return sc;
}

export function kin(opts: {
  s0?: number; v0?: number | null; accel?: number | null; mu_k?: number | null;
  length?: number; g?: number; asks?: Scene['asks'];
}): Scene {
  const sc = baseScene('直线测试');
  sc.gravity = opts.g ?? 10;
  const sup = makeSupport('horizontal', { x: 0, y: 0 }, opts.length ?? 100, 0);
  const block = makeBlock(sup.id, opts.s0 ?? 0);
  block.vel = { x: opts.v0 === undefined || opts.v0 === null ? null : opts.v0, y: 0 };
  block.accel = opts.accel ?? null;
  sc.supports = [sup];
  sc.bodies = [block];
  sc.contacts = [makeContact(block.id, sup.id, opts.mu_k ?? null, opts.mu_k ?? null)];
  sc.asks = opts.asks ?? [makeAsk('at_time', { t: 1 })];
  return sc;
}
