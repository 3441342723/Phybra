import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { baseScene, inclineExample, makeProjectile, makeSupport } from '../src/model/factory';
import { getAt, resolveBindings } from '../src/model/paths';
import type { Num, Scene } from '../src/model/types';
import { fieldValue, withBinding, withField, withFields } from '../src/state/editing';
import { initStore, reducer, type Action } from '../src/state/store';
import { NumericField } from '../src/ui/NumericField';
import { Properties } from '../src/ui/Properties';

function fixture(): Scene {
  const scene = baseScene();
  scene.bodies = [{ ...makeProjectile(1, 1, 1, 1), id: 'b1' }, { ...makeProjectile(), id: 'b2' }];
  scene.supports = [{ ...makeSupport('horizontal', { x: 1, y: 1 }), id: 's1' }];
  scene.params = ['p', 'q'].map((name) => ({ name, value: 1, unit: 'none', min: -20, max: 20, step: 1 }));
  return scene;
}

function expectValue(scene: Scene, path: string, value: Num) {
  expect(getAt(scene, path)).toBe(value);
  expect(fieldValue(scene, path)).toBe(value);
  expect(getAt(resolveBindings(scene), path)).toBe(value);
}

// Properties has no hooks: inspect its real element callbacks without a DOM dependency.
function elements(node: ReactNode): ReactElement[] {
  return Children.toArray(node).flatMap((child) => isValidElement<{ children?: ReactNode }>(child)
    ? [child, ...elements(child.props.children)] : []);
}

function properties(scene: Scene, dispatch: (action: Action) => void = () => {}) {
  const store = { ...initStore(scene), selection: scene.bodies[0].id };
  const fields = {
    transient: (path: string, value: unknown) => dispatch({ type: 'transient', scene: withField(scene, path, value) }),
    commit: (path: string, value: unknown) => dispatch({ type: 'apply', scene: withField(scene, path, value) }),
  };
  return Properties({ store, dispatch, fields });
}

describe('参数绑定与画布几何同步', () => {
  it('编辑绑定字段时同时更新命名参数和原始字段', () => {
    const scene = inclineExample();
    const sup = scene.supports[0];
    const next = withField(scene, `supports.${sup.id}.angleDeg`, 45);
    expect(next.params.find((p) => p.name === 'theta')?.value).toBe(45);
    expect(getAt(next, `supports.${sup.id}.angleDeg`)).toBe(45);
    expect(next.rev).toBe(scene.rev + 1);
  });

  it('编辑命名参数时同步所有绑定字段，画布与求解使用同一几何', () => {
    const scene = inclineExample();
    const sup = scene.supports[0];
    const next = withField(scene, 'params.theta.value', 50);
    expect(getAt(next, `supports.${sup.id}.angleDeg`)).toBe(50);
    expect(next.rev).toBe(scene.rev + 1);
  });

  it.each(['bodies.b1.pos', 'bodies.b1.vel', 'supports.s1.a'])('整对象编辑 %s 同步两个分量及外部别名，只增一次 rev', (path) => {
    const scene = fixture();
    scene.bindings = { [`${path}.x`]: 'p', [`${path}.y`]: 'q', 'bodies.b2.pos.x': 'p', 'bodies.b2.pos.y': 'q' };
    const before = structuredClone(scene);
    const next = withField(scene, path, { x: 7, y: -3 });
    expect(next.params.map((p) => p.value)).toEqual([7, -3]);
    for (const prefix of [path, 'bodies.b2.pos']) {
      expectValue(next, `${prefix}.x`, 7);
      expectValue(next, `${prefix}.y`, -3);
    }
    expect(next.rev).toBe(scene.rev + 1);
    expect(scene).toEqual(before);
  });

  it('一次端点编辑的长度、角度和附着位置共同检测冲突', () => {
    const scene = inclineExample();
    const support = scene.supports[0];
    const body = scene.bodies[0];
    scene.bindings[`supports.${support.id}.length`] = 'theta';
    const next = withFields(scene, [
      [`supports.${support.id}.length`, 8],
      [`supports.${support.id}.angleDeg`, 45],
      [`bodies.${body.id}.attach.s`, 8],
    ]);
    expect(next).toBe(scene);
  });

  it('一次端点编辑共同同步参数与附着位置，仅递增一次版本', () => {
    const scene = inclineExample();
    const support = scene.supports[0];
    const body = scene.bodies[0];
    const next = withFields(scene, [
      [`supports.${support.id}.length`, 8],
      [`supports.${support.id}.angleDeg`, 45],
      [`bodies.${body.id}.attach.s`, 8],
    ]);
    expect(next.supports[0].length).toBe(8);
    expect(next.params.find(p => p.name === 'theta')?.value).toBe(45);
    expect(next.bodies[0].attach?.s).toBe(8);
    expect(next.rev).toBe(scene.rev + 1);
  });

  it('复合写入仍更新未绑定分量，不影响其他参数', () => {
    const scene = fixture();
    scene.bindings = { 'bodies.b1.pos.x': 'p' };
    const next = withField(scene, 'bodies.b1.pos', { x: 9, y: 4 });
    expect(next.bodies[0].pos).toEqual({ x: 9, y: 4 });
    expect(next.params.map((p) => p.value)).toEqual([9, 1]);
  });

  it.each([8, null])('单字段提议 %s 广播给所有共享绑定，包含其他对象', (value) => {
    const scene = fixture();
    scene.bindings = { 'bodies.b1.vel.x': 'p', 'bodies.b1.vel.y': 'p', 'bodies.b2.vel.y': 'p' };
    const next = withField(scene, 'bodies.b1.vel.x', value);
    expect(next.params[0].value).toBe(value);
    for (const path of Object.keys(scene.bindings)) expectValue(next, path, value);
    expect(next.rev).toBe(scene.rev + 1);
  });

  it.each([8, null])('修改参数 %s 同步所有原始字段和有效值', (value) => {
    const scene = fixture();
    scene.bindings = { 'bodies.b1.vel.x': 'p', 'bodies.b2.vel.y': 'p' };
    const next = withField(scene, 'params.p.value', value);
    for (const path of Object.keys(scene.bindings)) expectValue(next, path, value);
    expect(next.rev).toBe(scene.rev + 1);
  });

  it.each([8, null])('同参数收到相等复合提议 %s 时正常广播', (value) => {
    const scene = fixture();
    scene.bindings = { 'bodies.b1.vel.x': 'p', 'bodies.b1.vel.y': 'p', 'bodies.b2.vel.x': 'p' };
    const next = withField(scene, 'bodies.b1.vel', { x: value, y: value });
    expect(next.params[0].value).toBe(value);
    for (const path of Object.keys(scene.bindings)) expectValue(next, path, value);
    expect(next.rev).toBe(scene.rev + 1);
  });

  it.each([false, true])('冲突原子拒绝且与绑定和候选键顺序无关（逆序=%s）', (reverse) => {
    const scene = fixture();
    const entries = [['bodies.b1.pos.x', 'p'], ['bodies.b1.vel.x', 'q'], ['bodies.b1.vel.y', 'q']];
    scene.bindings = Object.fromEntries(reverse ? entries.reverse() : entries);
    const before = structuredClone(scene);
    // y 未变化仍是一项提议；不能因 x 或独立参数 p 已更新而部分提交。
    const vel = reverse ? { y: 1, x: 6 } : { x: 6, y: 1 };
    const next = withField(scene, 'bodies', [{ ...scene.bodies[0], name: '不应写入', pos: { x: 9, y: 3 }, vel }, scene.bodies[1]]);
    expect(next).toBe(scene);
    expect(scene).toEqual(before);
  });

  it.each([false, true])('null 与数值复合提议冲突时返回原 scene（逆序=%s）', (reverse) => {
    const scene = fixture();
    const entries = [['bodies.b1.vel.x', 'p'], ['bodies.b1.vel.y', 'p']];
    scene.bindings = Object.fromEntries(reverse ? entries.reverse() : entries);
    expect(withField(scene, 'bodies.b1.vel', { x: null, y: 1 })).toBe(scene);
  });

  it.each([12, null])('建立、解除和重绑均物化当前参数值 %s，而非旧原始值', (value) => {
    const scene = fixture();
    scene.params[0].value = value;
    scene.params[1].value = -5;
    const path = 'bodies.b1.vel.x';
    const bound = withBinding(scene, path, 'p');
    expectValue(bound, path, value);
    expect(bound.rev).toBe(scene.rev + 1);
    expect(scene.bodies[0].vel.x).toBe(1);
    const rebound = withBinding(bound, path, 'q');
    expectValue(rebound, path, -5);
    expect(rebound.params[0].value).toBe(value);
    expect(rebound.rev).toBe(bound.rev + 1);
    const unbound = withBinding(bound, path, '');
    expect(unbound.bindings[path]).toBeUndefined();
    expectValue(unbound, path, value);
    expect(unbound.rev).toBe(bound.rev + 1);
    expectValue(withField(unbound, 'params.p.value', 99), path, value);
  });

  it.each([12, null])('解除旧场景中的绑定保留有效值 %s，而非陈旧原始值', (value) => {
    const scene = fixture();
    scene.params[0].value = value;
    scene.bindings = { 'bodies.b1.vel.x': 'p' };
    const next = withBinding(scene, 'bodies.b1.vel.x', '');
    expectValue(next, 'bodies.b1.vel.x', value);
    expect(next.bindings).toEqual({});
  });

  it.each([12, null])('删除参数时保留所有别名的有效值 %s，清除悬空绑定', (value) => {
    const scene = fixture();
    scene.params[0].value = value;
    scene.bindings = { 'bodies.b1.vel.x': 'p', 'bodies.b2.vel.x': 'p', 'bodies.b1.vel.y': 'q' };
    const before = structuredClone(scene);
    const next = withField(scene, 'params', scene.params.filter((p) => p.name !== 'p'));
    expect(next.params.map((p) => p.name)).toEqual(['q']);
    expect(next.bindings).toEqual({ 'bodies.b1.vel.y': 'q' });
    expectValue(next, 'bodies.b1.vel.x', value);
    expectValue(next, 'bodies.b2.vel.x', value);
    expectValue(next, 'bodies.b1.vel.y', 1);
    expect(next.rev).toBe(scene.rev + 1);
    expect(scene).toEqual(before);
    expectValue(withField(next, 'bodies.b1.vel.x', 3), 'bodies.b2.vel.x', value);
  });

  it('连续复合拖动及共享别名只需一次撤销重做', () => {
    const scene = fixture();
    scene.bindings = { 'bodies.b1.vel.x': 'p', 'bodies.b1.vel.y': 'p', 'bodies.b2.vel.x': 'p' };
    let store = reducer(initStore(scene), { type: 'beginGesture' });
    for (const value of [3, 5, 8]) {
      store = reducer(store, { type: 'transient', scene: withField(store.present, 'bodies.b1.vel', { x: value, y: value }) });
    }
    store = reducer(store, { type: 'endGesture' });
    const final = store.present;
    expect(final.rev).toBe(scene.rev + 3);
    expect(store.past).toEqual([scene]);
    expect(final.params[0].value).toBe(8);
    for (const path of Object.keys(scene.bindings)) expectValue(final, path, 8);
    store = reducer(store, { type: 'undo' });
    expect(store.present).toBe(scene);
    expect(store.past).toHaveLength(0);
    store = reducer(store, { type: 'redo' });
    expect(store.present).toBe(final);
    expect(store.future).toHaveLength(0);
    for (const path of Object.keys(scene.bindings)) expectValue(store.present, path, 8);
  });

  it('全程冲突的拖动不新增撤销记录', () => {
    const scene = fixture();
    scene.bindings = { 'bodies.b1.vel.x': 'p', 'bodies.b1.vel.y': 'p' };
    let store = reducer(initStore(scene), { type: 'beginGesture' });
    store = reducer(store, { type: 'transient', scene: withField(scene, 'bodies.b1.vel', { x: 4, y: 1 }) });
    store = reducer(store, { type: 'endGesture' });
    expect(store.present).toBe(scene);
    expect(store.past).toHaveLength(0);
  });
});

describe('属性面板的绑定编辑入口', () => {
  it('切换支撑面时夹取沿面位置并同步参数及别名，一次修订可撤销', () => {
    const scene = inclineExample();
    const body = scene.bodies[0];
    scene.supports.push(makeSupport('horizontal', { x: 0, y: 0 }, 2));
    scene.params.push({ name: 's', value: 5, unit: 'length', min: 0, max: 10, step: 1 });
    scene.bindings[`bodies.${body.id}.attach.s`] = 's';
    scene.bindings[`supports.${scene.supports[0].id}.a.x`] = 's';
    let store = initStore(scene);
    const tree = properties(scene, (action) => { store = reducer(store, action); });
    const select = elements(tree).find((el) => el.type === 'select')!;
    const target = scene.supports[1].id;
    select.props.onChange({ target: { value: target } });
    expect(store.present.bodies[0].attach).toEqual({ support: target, s: 2 });
    expect(store.present.params.find((p) => p.name === 's')?.value).toBe(2);
    expectValue(store.present, `supports.${scene.supports[0].id}.a.x`, 2);
    expect(store.present.contacts.some((c) => c.body === body.id && c.support === target)).toBe(true);
    expect(store.present.rev).toBe(scene.rev + 1);
    store = reducer(store, { type: 'undo' });
    expect(store.present).toBe(scene);
  });

  it.each(['x', 'y'])('任一速度分量 %s 有效值未知时，沿面速度显示未知', (axis) => {
    const scene = inclineExample();
    scene.params.push({ name: 'v', value: null, unit: 'speed', min: -10, max: 10, step: 1 });
    scene.bindings[`bodies.${scene.bodies[0].id}.vel.${axis}`] = 'v';
    const tree = properties(scene);
    const u = elements(tree).find((el) => el.type === NumericField && el.props.label.startsWith('沿面初速度'))!;
    expect(u.props.value).toBeNull();
    expect(renderToStaticMarkup(tree)).toContain(axis === 'x' ? 'vx=?' : 'vy=?');
  });

  it('沿面速度和分量说明读取绑定有效值而不是陈旧原始值', () => {
    const scene = inclineExample();
    scene.params.push({ name: 'v', value: 4, unit: 'speed', min: -10, max: 10, step: 1 });
    scene.bindings[`bodies.${scene.bodies[0].id}.vel.x`] = 'v';
    const tree = properties(scene);
    const u = elements(tree).find((el) => el.type === NumericField && el.props.label.startsWith('沿面初速度'))!;
    expect(u.props.value).toBeCloseTo(4 * Math.cos(Math.PI / 6));
    expect(renderToStaticMarkup(tree)).toContain('vx=4');
  });

  it.each(['onTransient', 'onCommit'])('沿面速度 %s 清空时两分量及共享参数保持 null', (handler) => {
    const scene = inclineExample();
    scene.params.push({ name: 'v', value: 4, unit: 'speed', min: -10, max: 10, step: 1 });
    const path = `bodies.${scene.bodies[0].id}.vel.x`;
    scene.bindings[path] = 'v';
    let store = initStore(scene);
    const tree = properties(scene, (action) => { store = reducer(store, action); });
    const u = elements(tree).find((el) => el.type === NumericField && el.props.label.startsWith('沿面初速度'))!;
    u.props[handler](null);
    expect(store.present.bodies[0].vel).toEqual({ x: null, y: null });
    expectValue(store.present, path, null);
    expect(store.present.params.find((p) => p.name === 'v')?.value).toBeNull();
  });

  it('共享绑定选择器附近提示冲突拖动的单字段或参数替代入口', () => {
    const scene = fixture();
    scene.bindings = { 'bodies.b1.vel.x': 'p', 'bodies.b1.vel.y': 'p' };
    const markup = renderToStaticMarkup(properties(scene));
    expect(markup).toContain('冲突拖动不修改，请用单字段/参数');
  });
});
