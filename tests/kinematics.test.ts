import { describe, expect, it } from 'vitest';
import { makeAsk } from '../src/model/factory';
import { solve } from '../src/solver';
import { answer, close, kin, ok } from './helpers';

describe('匀变速直线运动', () => {
  it('已知加速度：t=4 时 x=32, v=14', () => {
    const sol = ok(solve(kin({ v0: 2, accel: 3, length: 40, asks: [makeAsk('at_time', { t: 4 })] })));
    const askId = sol.answers.find((a) => a.id.endsWith('.x'))!.id.split('.')[0];
    close(answer(sol, `${askId}.x`).value, 32);
    close(answer(sol, `${askId}.v`).value, 14);
    close(answer(sol, 'accel').value, 3);
  });

  it('到达指定位置：x=30 → t≈3.8549', () => {
    const sol = ok(solve(kin({ v0: 2, accel: 3, length: 40, asks: [makeAsk('at_position', { x: 30 })] })));
    const t = (-2 + Math.sqrt(4 + 180)) / 3;
    close(sol.answers.find((a) => a.label.includes('30'))!.value, t, 1e-9);
  });

  it('达到指定速度：v=14 → t=4', () => {
    const sol = ok(solve(kin({ v0: 2, accel: 3, length: 400, asks: [makeAsk('at_velocity', { v: 14 })] })));
    close(sol.answers.find((a) => a.label.includes('14'))!.value, 4);
  });

  it('水平面摩擦减速：μk=0.2, v0=6, g=10 → 3s 停止，位移 9m', () => {
    const sol = ok(solve(kin({ v0: 6, mu_k: 0.2, g: 10 })));
    close(answer(sol, 'accel').value, -2);
    close(answer(sol, 'rest_t').value, 3);
    close(answer(sol, 'rest_x').value, 9);
    close(sol.evalAt(sol.tEnd).vx, 0, 1e-12);
  });

  it('光滑水平面：匀速直到端点', () => {
    const sol = ok(solve(kin({ v0: 5, mu_k: 0, length: 20 })));
    close(answer(sol, 'accel').value, 0);
    close(answer(sol, 'end_t').value, 4);
    close(answer(sol, 'end_v').value, 5);
  });

  it('反向运动：x=8 有两解 t=2 与 t=4', () => {
    const sol = ok(solve(kin({ v0: 6, accel: -2, length: 1000, asks: [makeAsk('at_position', { x: 8 })] })));
    const a = sol.answers.find((x) => x.label.includes('x=8'))!;
    close(a.value, 2);
    close(a.others![0].value, 4);
    expect(sol.flags).toContain('multi');
    close(answer(sol, 'rest_t').value, 3);
  });

  it('条件不足：既无加速度也无 μ_k', () => {
    const r = solve(kin({ v0: 3, accel: null, mu_k: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.report.blockers[0].message).toContain('μ');
  });

  it('停止之后再询问：仍报告静止位置，不编造新运动', () => {
    const sol = ok(solve(kin({ v0: 6, mu_k: 0.2, g: 10, asks: [makeAsk('at_time', { t: 99 })] })));
    const askId = sol.answers.find((a) => a.id.endsWith('.x'))!.id.split('.')[0];
    close(answer(sol, `${askId}.x`).value, 9);
    close(answer(sol, `${askId}.v`).value, 0);
  });

  it('越过端点终止后再询问：明确说明运动已结束', () => {
    const sol = ok(solve(kin({ v0: 5, mu_k: 0, length: 20, asks: [makeAsk('at_time', { t: 99 })] })));
    close(sol.tEnd, 4);
    expect(sol.answers.find((a) => a.label.includes('99'))!.value).toBeNull();
  });

  it('初始静止且光滑：保持静止', () => {
    const sol = ok(solve(kin({ v0: 0, mu_k: 0 })));
    for (const st of sol.samples) close(st.vx, 0, 1e-12);
  });
});
