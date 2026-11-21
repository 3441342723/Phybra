import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ELECTROMAGNETIC_EXAMPLES, EXAMPLES, flatThrowExample, inclineExample, kinematicsExample } from '../src/model/factory';
import { Canvas } from '../src/ui/Canvas';
import { initStore, reducer } from '../src/state/store';
import { setAt } from '../src/model/paths';
import { solve } from '../src/solver';
import { ok } from './helpers';

describe('一致性与统一模型', () => {
  it.each([...EXAMPLES, ...ELECTROMAGNETIC_EXAMPLES])('$title 的物体图形跟随播放结果，重置恢复且不改初始条件', ({ build }) => {
    const scene = build();
    const original = structuredClone(scene);
    const solution = ok(solve(scene));
    const initial = initStore(scene);
    const store = reducer(initial, { type: 'scrub', t: solution.tEnd / 2 });
    const sample = solution.evalAt(store.playback.t);
    const expectedX = store.camera.ox + sample.x * store.camera.scale;
    const expectedY = store.camera.oy - sample.y * store.camera.scale;
    const render = (state: typeof store) => renderToStaticMarkup(createElement(Canvas, {
      store: state, solution, dispatch: () => {},
      edit: { begin() {}, transient() {}, end() {}, apply() {} },
    }));
    const markup = render(store).match(/<g class="moving-body"[^>]*>.*?<\/g>/)?.[0] ?? '';
    if (scene.bodies[0].kind === 'block') {
      const body = markup.match(/<rect[^>]*class="body-block"[^>]*>/)?.[0];
      expect(body).toContain(`translate(${expectedX} ${expectedY})`);
    } else {
      const body = markup.match(/<circle[^>]*class="body-(?:projectile|circular)"[^>]*>/)?.[0];
      expect(body).toContain(`cx="${expectedX}"`);
      expect(body).toContain(`cy="${expectedY}"`);
    }
    expect(scene).toEqual(original);
    expect(render(reducer(store, { type: 'resetPlayback' }))).toBe(render(initial));
  });

  it('大范围轨迹缩小视图后网格数量仍受屏幕尺寸约束', () => {
    const scene = flatThrowExample();
    const store = initStore(scene, { scale: 0.5, ox: 450, oy: 260 });
    const markup = renderToStaticMarkup(createElement(Canvas, {
      store, solution: ok(solve(scene)), dispatch: () => {},
      edit: { begin() {}, transient() {}, end() {}, apply() {} },
    }));
    expect((markup.match(/class="(?:grid|axis)"/g) ?? []).length).toBeLessThan(200);
  });

  it('力学和电磁学示例均可求解', () => {
    for (const ex of [...EXAMPLES, ...ELECTROMAGNETIC_EXAMPLES]) {
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

  it('斜面工具创建的 0° 支撑面与旧版水平面求解一致', () => {
    const scene=kinematicsExample();
    const before=ok(solve(scene));
    scene.supports[0].kind='incline';
    const after=ok(solve(scene));
    expect(after.template).toBe('kinematics-1d');
    expect(after.evalAt(2)).toEqual(before.evalAt(2));
    expect(after.tEnd).toBe(before.tEnd);
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
