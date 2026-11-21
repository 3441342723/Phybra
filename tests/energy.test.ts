import { describe, expect, it } from 'vitest';
import { makeAsk, makeContact, makeSupport } from '../src/model/factory';
import type { EnergyEvent, EnergyPoint, Scene, Solution } from '../src/model/types';
import { solve } from '../src/solver';
import { isScene } from '../src/state/persist';
import { answer, close, incline, kin, ok, projectile } from './helpers';

const time = (t: number): EnergyPoint => ({ kind: 'time', t });
const event = (name: EnergyEvent): EnergyPoint => ({ kind: 'event', event: name });

function analysis({ energy }: Solution) {
  if (energy?.status !== 'ready') throw new Error('能量分析不可用');
  return energy;
}

describe('高中力学能量分析', () => {
  it('斜抛机械能守恒，关键事件与手填时间给出相同的能量', () => {
    const apex = makeAsk('energy_at', { energyFrom: event('apex') });
    const apexTime = makeAsk('energy_at', { energyFrom: time(0.4) });
    const landing = makeAsk('energy_at', { energyFrom: event('landing') });
    const work = makeAsk('work_between', { energyFrom: event('initial'), energyTo: event('landing') });
    const sc = projectile({ y: 5, vx: 3, vy: 4, asks: [apex, apexTime, landing, work] });
    sc.bodies[0].mass = 2;
    const sol = ok(solve(sc));
    for (const sample of analysis(sol).samples) {
      close(sample.mechanical, 125);
      close(sample.dissipated, 0);
    }
    close(answer(sol, `${apex.id}.kinetic`).value, 9);
    close(answer(sol, `${apex.id}.potential`).value, 116);
    close(answer(sol, `${apexTime.id}.potential`).value, 116);
    close(answer(sol, `${landing.id}.kinetic`).value, 125);
    expect(answer(sol, `${landing.id}.potential`).value).toBe(0);
    close(answer(sol, `${work.id}.gravity`).value, 100);
    close(answer(sol, `${work.id}.net`).value, 100);
  });

  it('光滑斜面在外端点把势能转为动能', () => {
    const end = makeAsk('energy_at', { energyFrom: event('end_of_support') });
    const sol = ok(solve(incline({ g: 10, length: 8, mu_s: 0, mu_k: 0, asks: [end] })));
    close(answer(sol, `${end.id}.kinetic`).value, 40);
    close(answer(sol, `${end.id}.potential`).value, 0);
    close(analysis(sol).evalAt(0)!.mechanical, 40);
  });

  it('水平面摩擦耗散，停止后的查询不延长播放', () => {
    const rest = makeAsk('energy_at', { energyFrom: event('final_rest') });
    const later = makeAsk('energy_at', { energyFrom: time(20) });
    const work = makeAsk('work_between', { energyFrom: time(1), energyTo: time(20) });
    const sc = kin({ v0: 4, mu_k: 0.2, asks: [rest, later, work] });
    sc.bodies[0].mass = 2;
    const sol = ok(solve(sc));
    close(sol.tEnd, 2);
    close(answer(sol, `${rest.id}.kinetic`).value, 0);
    close(answer(sol, `${later.id}.kinetic`).value, 0);
    close(answer(sol, `${work.id}.friction`).value, -4);
    close(answer(sol, `${work.id}.net`).value, -4);
    close(analysis(sol).evalAt(20)!.dissipated, 16);
    expect(analysis(sol).workBetween(1, 20)?.balance).toBe('verified');
  });

  it('上滑后反向时，摩擦耗散使用往返路程而非净位移', () => {
    const finalRest = makeAsk('energy_at', { energyFrom: event('final_rest') });
    const sc = incline({ s0: 2, length: 12, u: 4, mu_s: 0.2, mu_k: 0.1, asks: [finalRest] });
    const sol = ok(solve(sc));
    const rise = 4 ** 2 / (2 * (5 + Math.cos(Math.PI / 6)));
    const work = analysis(sol).workBetween(0, sol.tEnd)!;
    close(work.dissipated, Math.cos(Math.PI / 6) * (2 + 2 * rise));
    close(work.mechanicalChange, -work.dissipated!);
    expect(work.balance).toBe('verified');
    expect(answer(sol, finalRest.id).note).toContain('没有');
  });

  function connected(gap: number): Scene {
    const sc = kin({ v0: 6, mu_k: 0.1, length: 2, asks: [] });
    const next = makeSupport('horizontal', { x: 2 + gap, y: 0 }, 2, 0);
    sc.supports.push(next);
    sc.contacts.push(makeContact(sc.bodies[0].id, next.id, 0.2, 0.2));
    return sc;
  }

  it('连续轨道按各段摩擦累计，连接处的耗散连续', () => {
    const sol = ok(solve(connected(0)));
    const energy = analysis(sol);
    const join = sol.events.find((e) => e.kind === 'junction')!.t;
    close(energy.evalAt(join)!.dissipated, 2);
    close(energy.evalAt(sol.tEnd)!.dissipated, 6);
    expect(energy.workBetween(0, sol.tEnd)?.balance).toBe('verified');
  });

  it('连接处几何跳差时不宣称能量收支已核对', () => {
    const sc = connected(0);
    // 首段反方向注册：节点保留下一段的连接位置，上一段到达处存在跳差。
    sc.supports[1].a.y = 0.01;
    sc.supports.reverse();
    const sol = ok(solve(sc));
    expect(analysis(sol).workBetween(0, sol.tEnd)?.balance).toBe('geometry_gap');
    expect(analysis(sol).note).toContain('几何跳差');
  });

  it('仅给加速度可求合功，不能确定摩擦功及耗散', () => {
    const sc = kin({ v0: 0, accel: 2, mu_k: 0.3, asks: [] });
    sc.bodies[0].mass = 3;
    const energy = analysis(ok(solve(sc)));
    expect(energy.workBetween(0, 2)).toMatchObject({ gravity: 0, net: 24, kineticChange: 24, friction: null, dissipated: null });
    expect(energy.evalAt(2)!.dissipated).toBeNull();
  });

  it('缺质量与无效查询各自说明原因，原有运动仍可用', () => {
    const apex = makeAsk('energy_at', { energyFrom: event('apex') });
    const reversed = makeAsk('work_between', { energyFrom: time(0.4), energyTo: time(0.1) });
    const tooLate = makeAsk('energy_at', { energyFrom: time(99) });
    const missingTime = makeAsk('energy_at', { energyFrom: { kind: 'time', t: null } });
    const sc = projectile({ y: 5, vx: 3, asks: [apex, reversed, tooLate, missingTime] });
    const withoutMass = ok(solve(sc));
    expect(withoutMass.energy?.status).toBe('mass_required');
    expect(answer(withoutMass, apex.id).note).toContain('填写');
    sc.bodies[0].mass = 2;
    const sol = ok(solve(sc));
    expect(answer(sol, apex.id).note).toContain('没有');
    expect(answer(sol, reversed.id).note).toContain('早于');
    expect(answer(sol, tooLate.id).note).toContain('超出');
    expect(answer(sol, missingTime.id).note).toContain('时间');
    expect(analysis(sol).evalAt(99)).toBeNull();
    expect(sol.tEnd).toBe(1);
  });

  it('旧场景和新增待求项都保持场景 JSON v2 格式', () => {
    const old = JSON.parse(JSON.stringify(kin({ v0: 1, mu_k: 0, asks: [] })));
    expect(isScene(old)).toBe(true);
    const q = makeAsk('energy_at', { energyFrom: time(2) });
    old.asks.push(q);
    const saved = JSON.parse(JSON.stringify(old));
    expect(isScene(saved)).toBe(true);
    close(answer(ok(solve(saved)), `${q.id}.kinetic`).value, 0.5);
  });
});
