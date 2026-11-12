import { describe, expect, it } from 'vitest';
import { makeAsk } from '../src/model/factory';
import { solve } from '../src/solver';
import { answer, close, incline, ok } from './helpers';

const SIN30 = 0.5;
const COS30 = Math.sqrt(3) / 2;

describe('单物体斜面与摩擦', () => {
  it('由静止下滑：θ=30, μk=0.3, L=5, g=9.8', () => {
    const sol = ok(solve(incline({ mu_s: 0.4, mu_k: 0.3, g: 9.8, length: 5, s0: 5 })));
    const a = 9.8 * (SIN30 - 0.3 * COS30);
    close(answer(sol, 'accel').value, -a, 1e-9);
    close(answer(sol, 'end_t').value, Math.sqrt((2 * 5) / a), 1e-9);
    close(answer(sol, 'end_v').value, Math.sqrt(2 * a * 5), 1e-9);
    close(sol.evalAt(sol.tEnd).s, 0, 1e-9);
  });

  it('静摩擦自锁：μ_s=0.6 > tan30 → 静止，不到达端点', () => {
    const sol = ok(solve(incline({ mu_s: 0.6, mu_k: 0.5, u: 0 })));
    expect(answer(sol, 'friction').text).toContain('静止');
    expect(answer(sol, 'end_t').value).toBeNull();
    expect(sol.events.length).toBe(0);
    for (const st of sol.samples) close(st.s, 5, 1e-12);
  });

  it('临界状态：μ_s 恰等于 tanθ → 仍静止', () => {
    const sol = ok(solve(incline({ mu_s: Math.tan(Math.PI / 6), mu_k: 0.1, u: 0 })));
    expect(answer(sol, 'friction').text).toContain('静止');
  });

  it('临界略过：μ_s 比 tanθ 小 0.001 → 下滑', () => {
    const sol = ok(solve(incline({ mu_s: Math.tan(Math.PI / 6) - 0.001, mu_k: 0.1, u: 0 })));
    expect(answer(sol, 'friction').text).toContain('滑动');
    expect(sol.events.some((e) => e.kind === 'end_of_support')).toBe(true);
  });

  it('光滑斜面：a=-g sinθ', () => {
    const sol = ok(solve(incline({ mu_s: 0, mu_k: 0, g: 10, length: 5, s0: 5 })));
    close(answer(sol, 'accel').value, -5, 1e-12);
    close(answer(sol, 'end_t').value, Math.SQRT2, 1e-9);
    close(answer(sol, 'end_v').value, 5 * Math.SQRT2, 1e-9);
  });

  it('上滑减速后自锁：μ_s=0.6, μk=0.5, u0=+4', () => {
    const sol = ok(solve(incline({ mu_s: 0.6, mu_k: 0.5, u: 4, s0: 1, length: 10, g: 10 })));
    const aUp = -10 * (SIN30 + 0.5 * COS30);
    const tRest = -4 / aUp;
    close(sol.events.find((e) => e.kind === 'rest')!.t, tRest, 1e-9);
    close(sol.evalAt(tRest).s, 1 + (4 * tRest + 0.5 * aUp * tRest * tRest), 1e-9);
    expect(sol.events.some((e) => e.kind === 'end_of_support')).toBe(false);
    close(sol.evalAt(sol.tEnd).vx, 0, 1e-9);
  });

  it('上滑到最高点后转为下滑并到达底端（两段加速度不同）', () => {
    const sol = ok(solve(incline({ mu_s: 0.2, mu_k: 0.1, u: 2, s0: 1, length: 20, g: 10 })));
    const aUp = -10 * (SIN30 + 0.1 * COS30);
    const aDown = -10 * (SIN30 - 0.1 * COS30);
    const tRest = -2 / aUp;
    const sRest = 1 + 2 * tRest + 0.5 * aUp * tRest * tRest;
    const tDown = Math.sqrt((2 * sRest) / -aDown);
    expect(sol.stages.length).toBe(2);
    close(sol.stages[0].t1 - sol.stages[0].t0, tRest, 1e-9);
    close(answer(sol, 'end_t').value, tRest + tDown, 1e-8);
    close(answer(sol, 'end_v').value, Math.abs(aDown) * tDown, 1e-8);
  });

  it('下行且 μk>tanθ：减速到停止后保持静止', () => {
    const sol = ok(solve(incline({ mu_s: 0.9, mu_k: 0.8, u: -3, s0: 5, length: 5, g: 10 })));
    const a = -10 * SIN30 + 0.8 * 10 * COS30;
    close(sol.events.find((e) => e.kind === 'rest')!.t, 3 / a, 1e-9);
    expect(sol.events.some((e) => e.kind === 'end_of_support')).toBe(false);
    expect(sol.evalAt(sol.tEnd).s).toBeGreaterThan(0);
  });

  it('矛盾条件：μ_k > μ_s', () => {
    const r = solve(incline({ mu_s: 0.1, mu_k: 0.5 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.report.blockers[0].code).toBe('constraint_conflict');
  });

  it('条件不足：会滑动但未给 μ_k', () => {
    const r = solve(incline({ mu_s: 0.1, mu_k: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.report.blockers.some((b) => b.path.includes('mu_k'))).toBe(true);
  });

  it('自锁时不需要 μ_k（不编造摩擦参数）', () => {
    const sol = ok(solve(incline({ mu_s: 0.6, mu_k: null, u: 0 })));
    expect(answer(sol, 'friction').text).toContain('静止');
  });

  it('矛盾条件：物体初始位置超出斜面', () => {
    const r = solve(incline({ mu_s: 0.4, mu_k: 0.3, s0: 99, length: 5 }));
    expect(r.ok).toBe(false);
  });

  it('往返经过同一位置：多解', () => {
    const sol = ok(solve(incline({
      mu_s: 0.2, mu_k: 0.1, u: 2, s0: 1, length: 20, g: 10,
      asks: [makeAsk('at_position', { x: 1.2 })],
    })));
    const a = sol.answers.find((x) => x.label.includes('1.2'))!;
    expect(a.others?.length).toBe(1);
    expect(sol.flags).toContain('multi');
    expect(a.value!).toBeLessThan(a.others![0].value);
  });

  it('采样与分段解析式一致，且末点停在端点', () => {
    const sol = ok(solve(incline({ mu_s: 0.2, mu_k: 0.1, u: 2, s0: 1, length: 20, g: 10 })));
    for (const st of sol.samples) {
      const stage = sol.stages.find((sg) => st.t <= sg.t1 + 1e-9)!;
      const dt = st.t - stage.t0;
      const ev = sol.evalAt(st.t);
      close(ev.t, st.t, 1e-12);
      expect(st.s).toBeGreaterThanOrEqual(-1e-9);
      expect(dt).toBeGreaterThanOrEqual(-1e-9);
    }
    close(sol.samples[sol.samples.length - 1].s, 0, 1e-9);
  });
});
