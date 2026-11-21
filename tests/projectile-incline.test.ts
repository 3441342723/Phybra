import { describe, expect, it } from 'vitest';
import { baseScene, makeAsk, makeProjectile, makeSupport } from '../src/model/factory';
import type { Scene } from '../src/model/types';
import { solve } from '../src/solver';
import { answer, close, ok, projectile } from './helpers';

function inclineScene(opts: {
  angle: number; length?: number; ax?: number; ay?: number;
  x: number; y: number; vx: number; vy: number; g?: number; asks?: Scene['asks'];
}): Scene {
  const sc = baseScene('平抛落斜面测试');
  sc.gravity = opts.g ?? 10;
  sc.supports = [makeSupport('incline', { x: opts.ax ?? 0, y: opts.ay ?? 0 }, opts.length ?? 50, opts.angle)];
  sc.bodies = [makeProjectile(opts.x, opts.y, opts.vx, opts.vy)];
  sc.asks = opts.asks ?? [];
  return sc;
}

describe('抛体落到斜面', () => {
  it('45° 斜面 y=x：平抛 h=20, v0=10, g=10 → 解析交点', () => {
    const sol = ok(solve(inclineScene({ angle: 45, x: 0, y: 20, vx: 10, vy: 0 })));
    const t = (-10 + Math.sqrt(100 + 2 * 10 * 20)) / 10;
    close(answer(sol, 'hit_t').value, t, 1e-9);
    close(answer(sol, 'hit_x').value, 10 * t, 1e-9);
    close(answer(sol, 'hit_y').value, 10 * t, 1e-9);
    close(sol.tEnd, t, 1e-9);
    close(sol.evalAt(sol.tEnd).y, 10 * t, 1e-9);
    expect(sol.events.some((e) => e.kind === 'hit_support')).toBe(true);
    expect(sol.answers.some((a) => a.id === 'land_t')).toBe(false);
  });

  it('落到斜面后不再报告落地时间，且动画停在落点', () => {
    const sol = ok(solve(inclineScene({ angle: 30, length: 30, x: 0, y: 15, vx: 10, vy: 0 })));
    expect(sol.answers.some((a) => a.id === 'land_t')).toBe(false);
    const hit = answer(sol, 'hit_t').value!;
    expect(hit).toBeLessThan(Math.sqrt(2 * 10 * 15) / 10);
    close(sol.samples[sol.samples.length - 1].t, sol.tEnd, 1e-9);
  });

  it('斜面段太短够不到交点 → 仍落地，无 hit_t', () => {
    const sol = ok(solve(inclineScene({ angle: 45, length: 2, x: 0, y: 20, vx: 10, vy: 0 })));
    expect(sol.answers.some((a) => a.id === 'hit_t')).toBe(false);
    close(answer(sol, 'land_t').value, 2, 1e-9);
  });

  it('无斜面时退化为普通平抛', () => {
    const sol = ok(solve(projectile({ y: 20, vx: 10, vy: 0, g: 10 })));
    expect(sol.answers.some((a) => a.id === 'hit_t')).toBe(false);
    close(answer(sol, 'land_t').value, 2, 1e-9);
  });

  it('多斜面取最早落到段内的交点', () => {
    const sc = inclineScene({ angle: 45, length: 50, x: 0, y: 20, vx: 10, vy: 0 });
    sc.supports.push(makeSupport('incline', { x: 0, y: 0 }, 50, 30));
    const sol = ok(solve(sc));
    const t45 = (-10 + Math.sqrt(500)) / 10;
    close(answer(sol, 'hit_t').value, t45, 1e-9);
  });

  it('落到斜面之后的指定时刻报告运动已结束', () => {
    const sol = ok(solve(inclineScene({ angle: 45, x: 0, y: 20, vx: 10, vy: 0, asks: [makeAsk('at_time', { t: 5 })] })));
    const a = sol.answers.find((x) => x.label.includes('t=5'))!;
    expect(a.value).toBeNull();
  });
});