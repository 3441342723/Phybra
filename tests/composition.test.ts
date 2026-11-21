import { describe, expect, it } from 'vitest';
import { makeAsk } from '../src/model/factory';
import { solve } from '../src/solver';
import { answer, boat, close, ok } from './helpers';

describe('小船渡河（运动的合成与分解）', () => {
  it('船头垂直河岸：v船=4, v水=3, 河宽20 → t=5s, 漂移15m, 合速度5', () => {
    const sol = ok(solve(boat({ bvx: 0, bvy: 4, fx: 3, width: 20 })));
    close(answer(sol, 'cross_t').value, 5);
    close(answer(sol, 'cross_drift').value, 15);
    close(answer(sol, 'cross_v').value, 5);
    close(answer(sol, 'min_t').value, 5);
    close(answer(sol, 'min_disp').value, 20);
    close(sol.tEnd, 5);
  });

  it('一般航向：v船=(2,4), v水=3 → 合速度(5,4), t=5s, 漂移25m', () => {
    const sol = ok(solve(boat({ bvx: 2, bvy: 4, fx: 3, width: 20 })));
    close(answer(sol, 'cross_t').value, 5);
    close(answer(sol, 'cross_drift').value, 25);
    close(answer(sol, 'cross_v').value, Math.hypot(5, 4));
    close(answer(sol, 'min_t').value, 20 / Math.hypot(2, 4));
    close(answer(sol, 'min_disp').value, 20);
  });

  it('船速<水速：最短位移=河宽×水速/船速', () => {
    const sol = ok(solve(boat({ bvx: 0, bvy: 2, fx: 5, width: 20 })));
    close(answer(sol, 'cross_t').value, 10);
    close(answer(sol, 'cross_drift').value, 50);
    close(answer(sol, 'min_disp').value, 50);
  });

  it('指定时刻状态：t=2s → x=6, y=8, 速率5', () => {
    const sol = ok(solve(boat({ bvx: 0, bvy: 4, fx: 3, width: 20, asks: [makeAsk('at_time', { t: 2 })] })));
    const id = sol.answers.find((a) => a.label.includes('位置 x'))!.id;
    close(answer(sol, id).value, 6);
    const yid = sol.answers.find((a) => a.label.includes('位置 y'))!.id;
    close(answer(sol, yid).value, 8);
  });

  it('匀速直线：位置随时间线性，速度恒定', () => {
    const sol = ok(solve(boat({ bvx: 0, bvy: 4, fx: 3, width: 20 })));
    const a = sol.evalAt(1);
    const b = sol.evalAt(3);
    close(a.x, 3); close(a.y, 4);
    close(b.x, 9); close(b.y, 12);
    close(a.vx, 3); close(b.vx, 3); close(a.vy, 4); close(b.vy, 4);
  });

  it('到达对岸待求：时间与位置', () => {
    const sol = ok(solve(boat({ bvx: 0, bvy: 4, fx: 3, width: 20, asks: [makeAsk('landing')] })));
    const tid = sol.answers.find((a) => a.label === '到达对岸时间')!.id;
    close(answer(sol, tid).value, 5);
    const xid = sol.answers.find((a) => a.label === '到达对岸位置 x')!.id;
    close(answer(sol, xid).value, 15);
  });

  it('缺少河宽 → 条件不足', () => {
    const sc = boat({ width: 20 });
    sc.bodies[0].width = null;
    const r = solve(sc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.report.blockers)).toContain('河宽');
  });

  it('合速度沿河宽分量为负 → 冲突', () => {
    const r = solve(boat({ bvy: -1, fy: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.report.blockers)).toContain('对岸');
  });
});