import { describe, expect, it } from 'vitest';
import { makeAsk } from '../src/model/factory';
import { solve } from '../src/solver';
import { answer, close, ok, projectile } from './helpers';

describe('平抛与斜抛', () => {
  it('平抛：h=20, v0=10, g=10 → t=2s, R=20m', () => {
    const sol = ok(solve(projectile({ y: 20, vx: 10, vy: 0, g: 10 })));
    close(answer(sol, 'land_t').value, 2);
    close(answer(sol, 'land_range').value, 20);
    close(answer(sol, 'land_v').value, Math.hypot(10, 20));
    close(sol.tEnd, 2);
    close(sol.samples[0].y, 20);
    close(sol.samples[sol.samples.length - 1].y, 0, 1e-9);
  });

  it('斜抛自地面：vx=6, vy=8, g=10 → t=1.6s, R=9.6m, H=3.2m', () => {
    const sol = ok(solve(projectile({ y: 0, vx: 6, vy: 8, g: 10 })));
    close(answer(sol, 'land_t').value, 1.6);
    close(answer(sol, 'land_range').value, 9.6);
    close(answer(sol, 'apex_t').value, 0.8);
    close(answer(sol, 'apex_h').value, 3.2);
  });

  it('斜抛自高度 2m，g=9.8', () => {
    const sol = ok(solve(projectile({ y: 2, vx: 6, vy: 8, g: 9.8 })));
    const t = (8 + Math.sqrt(64 + 2 * 9.8 * 2)) / 9.8;
    close(answer(sol, 'land_t').value, t, 1e-9);
    close(answer(sol, 'land_range').value, 6 * t, 1e-9);
    close(answer(sol, 'apex_h').value, 2 + 64 / 19.6, 1e-9);
  });

  it('到达指定高度：上升段与下降段两解（多解标记）', () => {
    const sol = ok(solve(projectile({ y: 0, vx: 3, vy: 10, g: 10, asks: [makeAsk('at_height', { y: 3.75 })] })));
    const a = answer(sol, sol.answers.find((x) => x.label.includes('3.75'))!.id);
    close(a.value, 0.5);
    close(a.others![0].value, 1.5);
    expect(sol.flags).toContain('multi');
  });

  it('指定时刻状态：平抛 t=1 → x=10, y=15, vy=-10', () => {
    const sol = ok(solve(projectile({ y: 20, vx: 10, vy: 0, g: 10, asks: [makeAsk('at_time', { t: 1 })] })));
    close(answer(sol, `${sol.answers.find((a) => a.id.endsWith('.x'))!.id}`).value, 10);
    close(sol.evalAt(1).y, 15);
    close(sol.evalAt(1).vy, -10);
  });

  it('轨迹到不了的高度给出说明而非数字', () => {
    const sol = ok(solve(projectile({ y: 0, vx: 1, vy: 2, g: 10, asks: [makeAsk('at_height', { y: 100 })] })));
    const a = sol.answers.find((x) => x.label.includes('100'))!;
    expect(a.value).toBeNull();
    expect(a.note).toContain('不经过');
  });

  it('落地之后的时刻不再给状态', () => {
    const sol = ok(solve(projectile({ y: 20, vx: 10, vy: 0, g: 10, asks: [makeAsk('at_time', { t: 99 })] })));
    expect(sol.answers.find((a) => a.id === sol.answers[0].id)!.value).not.toBeUndefined();
    const late = sol.answers.find((a) => a.label.includes('99'))!;
    expect(late.value).toBeNull();
  });

  it('错误条件：地面处向下抛出 → 矛盾', () => {
    const r = solve(projectile({ y: 0, vx: 1, vy: -3 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.report.blockers[0].code).toBe('constraint_conflict');
  });

  it('条件不足：缺少竖直初速度', () => {
    const sc = projectile({ y: 5, vx: 2, vy: 0 });
    sc.bodies[0].vel.y = null;
    const r = solve(sc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.flags).toContain('insufficient');
      expect(r.report.blockers.some((b) => b.path.endsWith('vel.y'))).toBe(true);
    }
  });

  it('采样满足运动方程：y(t)=y0+vy t-½g t²', () => {
    const sol = ok(solve(projectile({ y: 3, vx: 4, vy: 5, g: 9.8 })));
    for (const st of sol.samples) {
      close(st.y, 3 + 5 * st.t - 4.9 * st.t * st.t, 1e-8);
      close(st.x, 4 * st.t, 1e-8);
    }
  });
});
