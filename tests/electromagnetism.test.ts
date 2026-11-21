import { describe, expect, it } from 'vitest';
import { demoDraft } from '../src/ai/demo';
import { ELECTROMAGNETIC_EXAMPLES, makeAsk } from '../src/model/factory';
import { getAt } from '../src/model/paths';
import { solve } from '../src/solver';
import { initStore, reducer } from '../src/state/store';
import { isScene } from '../src/state/persist';
import { answer, ok } from './helpers';

const example = (id: string) => ELECTROMAGNETIC_EXAMPLES.find(e => e.id === id)!.build();

describe('高中电磁学例题', () => {
  it('平行板由 U/d 得到场强，从静止加速，出板动能等于 qU', () => {
    const sc = example('parallel-plate-acceleration');
    const [exit, work] = sc.asks;
    const sol = ok(solve(sc));
    expect(sol.evalAt(0).ax).toBeCloseTo(1);
    expect(answer(sol, exit.id).value).toBeCloseTo(Math.sqrt(12), 8);
    expect(answer(sol, exit.id + '.speed').value).toBeCloseTo(Math.sqrt(12), 8);
    expect(answer(sol, work.id + '.electric').value).toBeCloseTo(12, 8);
    expect(sol.evalAt(sol.tEnd).ax).toBe(0);
  });

  it('平行板偏转：把到达板边的时间与全程时间区分，出场后速度不变', () => {
    const sc = example('parallel-plate-deflection');
    const [entry, exit] = sc.asks;
    const sol = ok(solve(sc));
    expect(answer(sol, entry.id).value).toBeCloseTo(0.25, 8);
    expect(answer(sol, exit.id).value).toBeCloseTo(2.25, 8);
    expect(answer(sol, exit.id + '.dwell').value).toBeCloseTo(2, 8);
    expect(answer(sol, exit.id + '.dy').value).toBeCloseTo(-2, 8);
    expect(sol.evalAt(sol.tEnd).vy).toBeCloseTo(-2, 8);
    expect(sol.tEnd).toBeCloseTo(3.25, 8);
  });

  it('磁场半圆返回：同一边界的两点间隔 2R，场内用时半个周期', () => {
    const sc = example('magnetic-return');
    const [entry, exit] = sc.asks;
    const sol = ok(solve(sc));
    expect(answer(sol, entry.id).value).toBeCloseTo(1 / 3, 8);
    expect(answer(sol, exit.id + '.x').value).toBeCloseTo(1, 8);
    expect(answer(sol, exit.id + '.y').value).toBeCloseTo(2, 8);
    expect(answer(sol, exit.id + '.vx').value).toBeCloseTo(-3, 8);
    expect(answer(sol, exit.id + '.dwell').value).toBeCloseTo(Math.PI, 8);
    expect(answer(sol, exit.id + '.radius').value).toBeCloseTo(3, 8);
    expect(answer(sol, exit.id + '.sweep').value).toBeCloseTo(180, 8);
  });

  it('速度选择区与偏转磁场共用边界，可以分别查询而不会提前停止', () => {
    const sc = example('selector-to-magnet');
    const [selectorExit, magnetEntry, magnetExit] = sc.asks;
    const sol = ok(solve(sc));
    expect(answer(sol, selectorExit.id).value).toBeCloseTo(5 / 3, 8);
    expect(answer(sol, selectorExit.id + '.selector_speed').value).toBeCloseTo(3, 8);
    expect(answer(sol, magnetEntry.id).value).toBe(answer(sol, selectorExit.id).value);
    expect(answer(sol, magnetEntry.id + '.vx').value).toBeCloseTo(3, 8);
    expect(answer(sol, magnetEntry.id + '.vy').value).toBeCloseTo(0, 8);
    expect(answer(sol, magnetExit.id).value).toBeCloseTo(5 / 3 + Math.PI, 8);
    expect(sol.events.filter(e => e.kind === 'field_crossing')).toHaveLength(3);
    expect(sol.tEnd).toBeCloseTo(5 / 3 + Math.PI + 0.5, 8);
  });

  it('小于一纳秒的相邻场区间隔仍作为两次穿越处理', () => {
    const sc = example('selector-to-magnet');
    const magnet = sc.fields!.at(-1)!;
    if (magnet.shape.kind !== 'rect') throw Error('Expected a rectangular field');
    magnet.shape.center = { ...magnet.shape.center, x: magnet.shape.center.x + 0.0005 };
    magnet.bz = 0;
    sc.bodies[0].vel.x = 1e6;
    sc.asks = sc.asks.slice(0, 2);
    sc.fieldPlayback = { duration: 1e-4, exit: 'continue', fieldId: null, afterExit: 0 };
    const sol = ok(solve(sc));
    const left = answer(sol, sc.asks[0].id).value!;
    const entered = answer(sol, sc.asks[1].id).value!;
    expect(entered - left).toBeCloseTo(5e-10, 11);
    expect(sol.events.filter(e => e.kind === 'field_crossing')).toHaveLength(4);
  });

  it('绑定的板间电压经过 JSON 恢复后仍控制电场，缺失值不当作零', () => {
    const sc = example('parallel-plate-acceleration');
    const path = `fields.${sc.fields![0].id}.plates.voltage`;
    sc.params = [{ name: 'U', unit: 'voltage', value: 48, min: 1, max: 100, step: 1 }];
    sc.bindings = { [path]: 'U' };
    const copy = JSON.parse(JSON.stringify(sc));
    expect(isScene(copy)).toBe(true);
    expect(ok(solve(copy)).evalAt(0).ax).toBeCloseTo(4);
    copy.params[0].value = null;
    expect(solve(copy)).toMatchObject({ ok: false, report: { blockers: [{ path: path.replace('.voltage', '') }] } });
  });

  it('查询未进过的场区时不会套用另一个场区的时间', () => {
    const sc = example('parallel-plate-acceleration');
    const entry = makeAsk('field_entry', { fieldId: sc.fields![0].id });
    const missing = makeAsk('field_exit', { fieldId: 'deleted-field' });
    sc.asks.push(entry, missing);
    const sol = ok(solve(sc));
    expect(answer(sol, entry.id).value).toBeNull();
    expect(answer(sol, missing.id).value).toBeNull();
  });

  it('亚秒场景默认用真实时间，手动倍率只改变播放进度', () => {
    const sc = example('parallel-plate-acceleration');
    sc.bodies[0].charge = 1e6;
    sc.fieldPlayback!.afterExit = 0;
    const sol = ok(solve(sc));
    expect(sol.tEnd).toBeCloseTo(Math.sqrt(12) / 1000, 9);
    const start = reducer(initStore(sc), { type: 'play' });
    expect(reducer(start, { type: 'tick', elapsed: 1 / 60, tEnd: sol.tEnd }).playback.t).toBe(sol.tEnd);
    const slow = reducer(start, { type: 'playbackRate', rate: 0.001 });
    const played = reducer(slow, { type: 'tick', elapsed: 1, tEnd: sol.tEnd });
    expect(played.playback).toMatchObject({ t: 0.001, mode: 'playing' });
    expect(played.present).toBe(sc);
    expect(reducer(played, { type: 'playbackRate', rate: -1 })).toBe(played);
    expect(answer(sol, sc.asks[0].id).value).toBe(sol.tEnd);
  });

  it('平行板草稿的已知量指向可编辑场景，并由同一求解器计算', () => {
    const draft = demoDraft('plates', '用户输入的其他题目');
    expect(draft.source.demo).toBe(true);
    for (const item of draft.known) {
      expect(draft.source.rawText).toContain(item.quote);
      expect(getAt(draft.scene, item.path)).toBeDefined();
    }
    const sol = ok(solve(draft.scene));
    expect(answer(sol, draft.scene.asks[0].id + '.speed').value).toBeCloseTo(Math.sqrt(12), 8);
  });
});
