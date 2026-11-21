import { ENERGY_EVENTS, isEnergyPoint } from '../model/energy';
import type { Ask, EnergyAnalysis, EnergyPoint, EnergySample, Scene, Solution } from '../model/types';
import { fmt } from '../model/units';
import type { runTrack } from './alongTrack';
import { EPS, latexNum } from './common';

type TrackEnergy = {
  track: ReturnType<typeof runTrack>;
  prescribedAccel?: number;
  geometryGap?: boolean;
};

const MASS_REQUIRED = '请在物体属性中填写大于 0 的质量，才能计算以焦耳表示的能量和功。';
const UNKNOWN_FRICTION = '已知加速度可以求合功，无法单独确定摩擦功或耗散。';
const GEOMETRY_GAP = '轨道连接处存在几何跳差，无法可靠核对能量收支。';

function createAnalysis(scene: Scene, solution: Solution, model?: TrackEnergy): EnergyAnalysis {
  const m = scene.bodies[0].mass;
  if (m === null || !Number.isFinite(m) || m <= 0) return { status: 'mass_required', note: MASS_REQUIRED };
  const mg = m * scene.gravity!;
  const prescribed = model?.prescribedAccel;

  // 每段在速度归零或换面处切开，因此段内路程就是位移的绝对值。
  let total = 0;
  const losses = (model?.track.stages ?? []).map((se) => {
    const before = total;
    const rate = m * (se.frictionPerMass ?? 0);
    const end = se.eval(se.stage.t1 - se.stage.t0);
    total += rate * Math.abs(end.s - se.s0);
    return { se, before, rate };
  });

  function evalAt(t: number): (EnergySample & { potential: number; mechanical: number }) | null {
    if (!Number.isFinite(t) || t < 0 || (t > solution.tEnd + EPS && model?.track.outcome !== 'stationary')) return null;
    const st = solution.evalAt(Math.min(t, solution.tEnd));
    const kinetic = 0.5 * m! * (st.vx ** 2 + st.vy ** 2);
    const potential = mg * st.y;
    const phase = losses.find(({ se }) => st.t <= se.stage.t1);
    const dissipated = prescribed !== undefined ? null : !phase ? total
      : phase.before + phase.rate * Math.abs(phase.se.eval(st.t - phase.se.stage.t0).s - phase.se.s0);
    return { t, kinetic, potential, mechanical: kinetic + potential, dissipated };
  }

  const ready: EnergyAnalysis = {
    status: 'ready',
    samples: solution.samples.map((s) => evalAt(s.t)!),
    evalAt,
    workBetween(from, to) {
      const a = evalAt(from);
      const b = evalAt(to);
      if (!a || !b || to < from) return null;
      const gravity = a.potential - b.potential;
      const dissipated = a.dissipated === null || b.dissipated === null ? null : b.dissipated - a.dissipated;
      const friction = dissipated === null ? null : -dissipated || 0;
      const net = prescribed === undefined ? gravity + (friction ?? 0)
        : m * prescribed * (solution.evalAt(to).x - solution.evalAt(from).x);
      const kineticChange = b.kinetic - a.kinetic;
      const mechanicalChange = b.mechanical - a.mechanical;
      const tolerance = 1e-8 * Math.max(1, a.kinetic, b.kinetic, Math.abs(a.potential), Math.abs(b.potential), Math.abs(net));
      const mismatch = Math.abs(kineticChange - net) > tolerance
        || (dissipated !== null && Math.abs(mechanicalChange + dissipated) > tolerance);
      return {
        gravity, friction, net, dissipated, kineticChange, mechanicalChange,
        balance: model?.geometryGap ? 'geometry_gap' : mismatch ? 'mismatch' : 'verified',
      };
    },
    note: [model?.geometryGap && GEOMETRY_GAP, prescribed !== undefined && UNKNOWN_FRICTION].filter(Boolean).join(' ') || undefined,
  };
  return ready;
}

function resolvePoint(point: EnergyPoint | undefined, solution: Solution, stationary: boolean, incomplete: boolean):
  { t: number; label: string } | { error: string } {
  if (!isEnergyPoint(point)) return { error: '请选择时间点或关键事件。' };
  if (point.kind === 'time') {
    if (point.t === null || !Number.isFinite(point.t) || point.t < 0) return { error: '请填写非负的有限时间。' };
    if (!stationary && point.t > solution.tEnd + EPS) return { error: '该时刻超出已求解的运动范围。' };
    return { t: point.t, label: `t=${fmt(point.t)} s` };
  }

  const label = ENERGY_EVENTS.find(({ id }) => id === point.event)!.label;
  const t = point.event === 'initial' ? 0 : point.event === 'final_rest'
    ? (stationary ? solution.tEnd : undefined)
    : solution.events.find((e) => e.kind === point.event)?.t;
  if (t === undefined) {
    return { error: incomplete ? `已求解的阶段中未出现「${label}」，后续运动尚未确定。` : `当前运动中没有「${label}」事件。` };
  }
  return { t, label: `${label}（${fmt(t)} s）` };
}

function reject(ask: Ask, note: string) {
  return {
    id: ask.id, label: ask.kind === 'energy_at' ? '某时刻的能量' : '两时刻之间的做功与耗散',
    value: null, unit: 'J', note,
  };
}

export function reportUnsupportedEnergyQueries(scene: Scene, solution: Solution) {
  for (const ask of scene.asks) {
    if (ask.kind === 'energy_at' || ask.kind === 'work_between') {
      solution.answers.push(reject(ask, '当前题型暂不支持能量分析。'));
    }
  }
}

export function withEnergy(scene: Scene, solution: Solution, model?: TrackEnergy): Solution {
  const energy = createAnalysis(scene, solution, model);
  const stationary = model?.track.outcome === 'stationary';
  const incomplete = model?.track.outcome === 'incomplete';
  const m = scene.bodies[0].mass!;
  const g = scene.gravity!;
  for (const ask of scene.asks) {
    if (ask.kind !== 'energy_at' && ask.kind !== 'work_between') continue;
    if (energy.status !== 'ready') {
      solution.answers.push(reject(ask, energy.note));
      continue;
    }
    const from = resolvePoint(ask.energyFrom, solution, stationary, incomplete);
    if ('error' in from) {
      solution.answers.push(reject(ask, ask.kind === 'work_between' ? `起点：${from.error}` : from.error));
      continue;
    }
    if (ask.kind === 'energy_at') {
      const e = energy.evalAt(from.t)!;
      const st = solution.evalAt(from.t);
      solution.answers.push(
        { id: `${ask.id}.kinetic`, label: `${from.label} · 动能`, value: e.kinetic, unit: 'J' },
        { id: `${ask.id}.potential`, label: `${from.label} · 重力势能`, value: e.potential, unit: 'J', note: '以 y=0 为零势能面' },
        { id: `${ask.id}.mechanical`, label: `${from.label} · 机械能`, value: e.mechanical, unit: 'J' },
      );
      solution.steps.push({
        title: `${from.label}的能量`,
        formula: 'E_k=\\tfrac12m(v_x^2+v_y^2),\\quad E_p=mgy,\\quad E_m=E_k+E_p',
        substitution: `m=${latexNum(m)}\\,\\mathrm{kg},\\quad g=${latexNum(g)}\\,\\mathrm{m/s^2},\\quad y=${latexNum(st.y)}\\,\\mathrm{m},\\quad |v|=${latexNum(Math.hypot(st.vx, st.vy))}\\,\\mathrm{m/s}`,
        note: '以 y=0 为零势能面。',
      });
      continue;
    }

    const to = resolvePoint(ask.energyTo, solution, stationary, incomplete);
    if ('error' in to || to.t < from.t) {
      solution.answers.push(reject(ask, 'error' in to ? `终点：${to.error}` : '结束时刻不能早于开始时刻。'));
      continue;
    }
    const work = energy.workBetween(from.t, to.t)!;
    const range = `${from.label} → ${to.label}`;
    const note = work.balance === 'geometry_gap' ? GEOMETRY_GAP : work.balance === 'mismatch' ? '做功与能量变化不一致，请检查当前模型。' : undefined;
    solution.answers.push(
      { id: `${ask.id}.gravity`, label: `${range} · 重力功`, value: work.gravity, unit: 'J' },
      { id: `${ask.id}.friction`, label: `${range} · 摩擦功`, value: work.friction, unit: 'J', note: work.friction === null ? UNKNOWN_FRICTION : undefined },
      { id: `${ask.id}.net`, label: `${range} · 合功`, value: work.net, unit: 'J', note },
      { id: `${ask.id}.dissipated`, label: `${range} · 摩擦耗散`, value: work.dissipated, unit: 'J', note: work.dissipated === null ? UNKNOWN_FRICTION : undefined },
    );
    solution.steps.push({
      title: `${range} 的做功与能量收支`,
      formula: model?.prescribedAccel !== undefined
        ? 'W_g=-\\Delta E_p,\\quad W_{\\mathrm{net}}=ma\\Delta x'
        : model
          ? 'W_g=-\\Delta E_p,\\quad Q=\\sum_i\\mu_{k,i}mg\\cos\\theta_i\\,\\ell_i,\\quad W_f=-Q,\\quad W_{\\mathrm{net}}=W_g+W_f'
          : 'W_g=-\\Delta E_p,\\quad W_f=0,\\quad W_{\\mathrm{net}}=W_g',
      substitution: `W_g=${latexNum(work.gravity)}\\,\\mathrm{J},\\quad W_{\\mathrm{net}}=${latexNum(work.net)}\\,\\mathrm{J},\\quad \\Delta E_k=${latexNum(work.kineticChange)}\\,\\mathrm{J}`
        + (work.dissipated === null || work.mechanicalChange === null ? '' : `,\\quad Q=${latexNum(work.dissipated)}\\,\\mathrm{J},\\quad \\Delta E_m=${latexNum(work.mechanicalChange)}\\,\\mathrm{J}`),
      note: [energy.note, work.balance === 'verified'
        ? (work.dissipated === null ? '合功等于动能的变化量。' : '合功等于动能的变化量，机械能减少量等于摩擦耗散。')
        : (work.balance === 'mismatch' ? note : undefined)].filter(Boolean).join(' '),
    });
  }
  return { ...solution, energy };
}
