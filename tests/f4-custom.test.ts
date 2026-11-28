import { describe, expect, it } from 'vitest';
import { validateSceneDraft } from '../functions/draft-schema';
import { validateScene } from '../src/model/validate';
import { toSI } from '../src/model/units';
import { solve } from '../src/solver';

function unsupportedSpringScene() {
  return {
    version: 2 as const,
    rev: 0,
    title: '弹簧振子（当前不支持）',
    gravity: 0,
    bodies: [
      { id: 'a', kind: 'block' as const, name: '物块 A', attach: { support: 'surface', s: null }, pos: { x: null, y: null }, vel: { x: null, y: 0 }, mass: null, accel: null },
      { id: 'b', kind: 'block' as const, name: '物块 B', attach: { support: 'surface', s: null }, pos: { x: null, y: null }, vel: { x: null, y: 0 }, mass: null, accel: null },
    ],
    supports: [{ id: 'surface', name: '水平面', kind: 'horizontal' as const, a: { x: 0, y: 0 }, length: null, angleDeg: 0 }],
    contacts: [
      { id: 'ca', body: 'a', support: 'surface', mu_s: 0, mu_k: 0 },
      { id: 'cb', body: 'b', support: 'surface', mu_s: 0, mu_k: 0 },
    ],
    asks: [
      { id: 'period', kind: 'custom' as const, t: null, x: null, y: null, v: null, question: '求振动周期' },
      { id: 'compression', kind: 'custom' as const, t: null, x: null, y: null, v: null, question: '求最大压缩量' },
    ],
    params: [{ name: 'k', value: 100, unit: 'stiffness' as const, min: 0, max: 1000, step: 1, note: '弹簧劲度系数（仅记录量纲）' }],
    bindings: {},
  };
}

function solvableUnsupportedSpringScene() {
  const scene = unsupportedSpringScene() as any;
  scene.bodies = [scene.bodies[0]];
  scene.contacts = [scene.contacts[0]];
  scene.bodies[0].attach.s = 0;
  scene.bodies[0].vel.x = 0;
  scene.asks = [{ id: 'period', kind: 'custom', t: null, x: null, y: null, v: null, question: '求振动周期' }];
  return scene;
}

describe('F4 不支持题的保留与量纲', () => {
  it('custom-only 的不支持场景不额外阻塞 g=0 或缺失支撑长度', () => {
    const report = validateScene(unsupportedSpringScene());
    expect(report.blockers.some((item) => item.path === 'gravity')).toBe(false);
    expect(report.blockers.some((item) => item.path === 'supports.surface.length')).toBe(false);
    expect(report.blockers.some((item) => item.path === 'bodies')).toBe(true);
  });

  it('弹簧劲度系数使用 N/m，而不是伪装成无量纲', () => {
    const scene = unsupportedSpringScene();
    const draft = {
      source: { rawText: '轻质弹簧，k=100 N/m' },
      scene,
      known: [],
      assumed: [],
      unknown: [],
      uncertain: [],
      warnings: ['当前没有弹簧求解器，仅保留题面和参数。'],
    };
    const parsed = validateSceneDraft(draft) as any;
    expect(parsed.scene.params[0].unit).toBe('stiffness');
    expect(toSI(100, 'N/m', 'stiffness')).toBe(100);
  });

  it('单物块 custom-only 弹簧题不输出普通直线运动答案', () => {
    const scene = solvableUnsupportedSpringScene();
    expect(validateScene(scene).blockers).toEqual([]);
    const result = solve(scene);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.solution.notice).toContain('不支持弹簧动力学');
    expect(result.solution.answers).toHaveLength(1);
    expect(result.solution.answers[0].id).toBe('period');
    expect(result.solution.answers.some((answer) => ['accel', 'end_t', 'end_v'].includes(answer.id))).toBe(false);
  });
});
