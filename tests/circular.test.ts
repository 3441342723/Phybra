import { describe, expect, it } from 'vitest';
import { makeAsk } from '../src/model/factory';
import { solve } from '../src/solver';
import { answer, circular, close, ok } from './helpers';

describe('匀速圆周运动', () => {
  it('r=5, ω=1, m=2 → v=5, T=2π, a=5, F=10', () => {
    const sol = ok(solve(circular({ radius: 5, omega: 1, mass: 2 })));
    close(answer(sol, 'v').value, 5);
    close(answer(sol, 'omega').value, 1);
    close(answer(sol, 'T').value, 2 * Math.PI);
    close(answer(sol, 'a').value, 5);
    close(answer(sol, 'F').value, 10);
    close(sol.tEnd, 2 * Math.PI);
  });

  it('参数方程：t=0 在 (r,0)，t=T/4 在 (0,r)，速度沿切线', () => {
    const sol = ok(solve(circular({ cx: 0, cy: 0, radius: 5, omega: 1, phase: 0 })));
    const s0 = sol.evalAt(0);
    close(s0.x, 5); close(s0.y, 0); close(s0.vx, 0); close(s0.vy, 5);
    const sq = sol.evalAt(sol.tEnd / 4);
    close(sq.x, 0, 1e-9); close(sq.y, 5); close(sq.vx, -5); close(sq.vy, 0, 1e-9);
  });

  it('速率恒定，向心加速度大小不变', () => {
    const sol = ok(solve(circular({ radius: 2, omega: 3 })));
    for (const t of [0, 0.3, 0.7, 1.5]) {
      const s = sol.evalAt(t);
      close(Math.hypot(s.vx, s.vy), 6);
    }
    close(answer(sol, 'a').value, 18);
  });

  it('质量未知 → 向心力为 null（不臆造），其余量可求', () => {
    const sol = ok(solve(circular({ radius: 2, omega: 3, mass: null })));
    close(answer(sol, 'v').value, 6);
    close(answer(sol, 'a').value, 18);
    expect(answer(sol, 'F').value).toBeNull();
  });

  it('指定时刻状态：t=1 → x=5cos1, y=5sin1', () => {
    const sol = ok(solve(circular({ radius: 5, omega: 1, phase: 0, asks: [makeAsk('at_time', { t: 1 })] })));
    const xid = sol.answers.find((a) => a.label.includes('位置 x'))!.id;
    const yid = sol.answers.find((a) => a.label.includes('位置 y'))!.id;
    close(answer(sol, xid).value, 5 * Math.cos(1));
    close(answer(sol, yid).value, 5 * Math.sin(1));
  });

  it('圆心偏移与初相位', () => {
    const sol = ok(solve(circular({ cx: 3, cy: -2, radius: 4, omega: 2, phase: Math.PI / 2 })));
    const s0 = sol.evalAt(0);
    close(s0.x, 3, 1e-9); close(s0.y, 2);
    close(answer(sol, 'v').value, 8);
    close(answer(sol, 'T').value, Math.PI);
  });

  it('缺少半径 → 条件不足', () => {
    const sc = circular({ radius: 5 });
    sc.bodies[0].radius = null;
    const r = solve(sc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.report.blockers)).toContain('半径');
  });

  it('角速度为零 → 冲突', () => {
    const r = solve(circular({ omega: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.report.blockers)).toContain('角速度');
  });
});