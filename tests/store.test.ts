import { describe, expect, it } from 'vitest';
import { flatThrowExample, inclineExample } from '../src/model/factory';
import { activeSolution, initStore, reducer, type Store } from '../src/state/store';
import { withField } from '../src/state/editing';
import { solve } from '../src/solver';

function base(): Store {
  return initStore(inclineExample());
}

function anglePath(store: Store): string {
  return Object.keys(store.present.bindings).find((p) => p.endsWith('angleDeg'))!;
}

describe('编辑 / 播放 / 视图状态分离', () => {
  it('修改物理条件：暂停播放、回到初始时刻、正式结果标记待更新', () => {
    let st = base();
    const r = solve(st.present);
    if (!r.ok) throw new Error('示例不可解');
    st = reducer(st, { type: 'formalResult', rev: st.present.rev, result: { solution: r.solution, report: null } });
    st = reducer(st, { type: 'play' });
    st = reducer(st, { type: 'tick', t: 1.2, tEnd: 5 });
    const next = { ...st.present, gravity: 10, rev: st.present.rev + 1 };
    st = reducer(st, { type: 'apply', scene: next });
    expect(st.playback).toEqual({ mode: 'idle', t: 0 });
    expect(st.formal.status).toBe('stale');
    expect(st.formal.solution).not.toBeNull();
  });

  it('缩放与平移不改变场景与 rev，不触发重算', () => {
    let st = base();
    const before = st.present;
    const formalBefore = st.formal;
    st = reducer(st, { type: 'camera', camera: { scale: 99, ox: -30, oy: 120 } });
    expect(st.present).toBe(before);
    expect(st.formal).toBe(formalBefore);
    expect(activeSolution(st)).toBeNull();
  });

  it('拖动时间轴只改变观察时刻', () => {
    let st = base();
    const before = st.present;
    st = reducer(st, { type: 'scrub', t: 1.5 });
    expect(st.present).toBe(before);
    expect(st.playback.t).toBe(1.5);
  });

  it('重置播放保留最后确认的初始场景', () => {
    let st = base();
    const before = st.present;
    st = reducer(st, { type: 'scrub', t: 2 });
    st = reducer(st, { type: 'resetPlayback' });
    expect(st.present).toBe(before);
    expect(st.playback).toEqual({ mode: 'idle', t: 0 });
  });

  it('一次连续拖动 = 一步撤销', () => {
    let st = base();
    const original = st.present;
    const path = anglePath(st);
    st = reducer(st, { type: 'beginGesture' });
    for (const angle of [31, 33, 36, 40]) {
      st = reducer(st, { type: 'transient', scene: withField(st.present, path, angle) });
    }
    st = reducer(st, { type: 'endGesture' });
    expect(st.past.length).toBe(1);
    expect(st.present.params.find((p) => p.name === 'theta')?.value).toBe(40);
    st = reducer(st, { type: 'undo' });
    expect(st.present).toBe(original);
    expect(st.past.length).toBe(0);
    expect(st.future.length).toBe(1);
    st = reducer(st, { type: 'redo' });
    expect(st.present.params.find((p) => p.name === 'theta')?.value).toBe(40);
  });

  it('直接编辑属性：每次提交一步，撤销可回退', () => {
    let st = base();
    st = reducer(st, { type: 'apply', scene: { ...st.present, gravity: 10, rev: st.present.rev + 1 } });
    expect(st.present.gravity).toBe(10);
    st = reducer(st, { type: 'undo' });
    expect(st.present.gravity).toBe(9.8);
  });

  it('AI 草稿替换场景可一步撤销', () => {
    let st = base();
    const before = st.present;
    const draftScene = flatThrowExample();
    st = reducer(st, { type: 'apply', scene: { ...draftScene, rev: before.rev + 1 } });
    expect(st.present.bodies[0].kind).toBe('projectile');
    st = reducer(st, { type: 'undo' });
    expect(st.present).toBe(before);
  });

  it('activeSolution 只接受与当前 rev 一致的结果', () => {
    let st = base();
    const r = solve(st.present);
    if (!r.ok) throw new Error('示例不可解');
    st = reducer(st, { type: 'previewResult', rev: st.present.rev, result: { solution: r.solution, report: null } });
    expect(activeSolution(st)).toBe(r.solution);
    st = reducer(st, { type: 'apply', scene: { ...st.present, gravity: 10, rev: st.present.rev + 1 } });
    expect(activeSolution(st)).toBeNull();
  });

  it('迟到的预览结果不会覆盖新场景', () => {
    let st = base();
    const oldRev = st.present.rev;
    const r = solve(st.present);
    if (!r.ok) throw new Error('示例不可解');
    st = reducer(st, { type: 'apply', scene: { ...st.present, gravity: 10, rev: oldRev + 1 } });
    st = reducer(st, { type: 'previewResult', rev: oldRev, result: { solution: r.solution, report: null } });
    expect(st.preview.solution).toBeNull();
  });
});
