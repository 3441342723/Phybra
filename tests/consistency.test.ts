import { describe, expect, it } from 'vitest';
import { EXAMPLES, flatThrowExample, inclineExample } from '../src/model/factory';
import { setAt } from '../src/model/paths';
import { solve } from '../src/solver';
import { ok } from './helpers';

describe('一致性与统一模型', () => {
  it('四个示例场景均可求解', () => {
    for (const ex of EXAMPLES) {
      const r = solve(ex.build());
      expect(r.ok, ex.title).toBe(true);
    }
  });

  it('同一模型的两种构建方式得到相同答案', () => {
    const a = ok(solve(flatThrowExample()));
    const manual = flatThrowExample();
    manual.bodies[0].id = 'another-id';
    manual.asks = [];
    const b = ok(solve(manual));
    expect(a.answers.find((x) => x.id === 'land_t')!.value).toBe(b.answers.find((x) => x.id === 'land_t')!.value);
    expect(a.answers.find((x) => x.id === 'land_range')!.value).toBe(b.answers.find((x) => x.id === 'land_range')!.value);
  });

  it('命名参数绑定与直接填值等价', () => {
    const bound = ok(solve(inclineExample()));
    const directScene = inclineExample();
    const anglePath = Object.keys(directScene.bindings).find((p) => p.endsWith('angleDeg'))!;
    const muPath = Object.keys(directScene.bindings).find((p) => p.endsWith('mu_k'))!;
    let direct = setAt(directScene, anglePath, 30);
    direct = setAt(direct, muPath, 0.3);
    direct.bindings = {};
    const unbound = ok(solve(direct));
    expect(bound.answers.find((a) => a.id === 'end_t')!.value).toBeCloseTo(unbound.answers.find((a) => a.id === 'end_t')!.value!, 12);
  });

  it('修改绑定参数只改参数值即可改变结果', () => {
    const sc = inclineExample();
    const changed = { ...sc, params: sc.params.map((p) => (p.name === 'theta' ? { ...p, value: 45 } : p)) };
    const a = ok(solve(sc)).answers.find((x) => x.id === 'end_t')!.value!;
    const b = ok(solve(changed)).answers.find((x) => x.id === 'end_t')!.value!;
    expect(a).not.toBeCloseTo(b, 6);
  });

  it('多解与待求量缺参会显式标记', () => {
    const sc = flatThrowExample();
    sc.asks[1].t = null;
    const r = solve(sc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.report.blockers.some((b) => b.path.startsWith('asks.'))).toBe(true);
  });

  it('不支持的组合明确拒绝', () => {
    const sc = inclineExample();
    sc.bodies.push({ ...sc.bodies[0], id: 'b-second' });
    const r = solve(sc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.report.blockers[0].code).toBe('unsupported_combo');
  });
});
