import type { Answer, DerivationStep, Sample, Scene } from '../model/types';
import { fmt } from '../model/units';
import { dedupeNumbers, EPS, latexNum } from './common';
import { issue, missing, type Template } from './template';

export const circularTemplate: Template = {
  id: 'circular',
  match: (scene) => scene.bodies.length === 1 && scene.bodies[0].kind === 'circular',
  solve(scene: Scene) {
    const body = scene.bodies[0];
    const blockers = [];
    const pending: Array<{ path: string; label: string }> = [];
    const bp = `bodies.${body.id}`;
    for (const [path, value, label] of [
      [`${bp}.pos.x`, body.pos.x, '圆心 x'],
      [`${bp}.pos.y`, body.pos.y, '圆心 y'],
      [`${bp}.radius`, body.radius, '半径'],
      [`${bp}.omega`, body.omega, '角速度'],
    ] as const) {
      if (value === null) blockers.push(missing(path, `缺少${label}`));
    }
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['insufficient'] };

    const cx = body.pos.x!;
    const cy = body.pos.y!;
    const r = body.radius!;
    const omega = body.omega!;
    if (r <= 0) blockers.push(issue('constraint_conflict', `${bp}.radius`, '半径必须为正'));
    if (Math.abs(omega) <= EPS) blockers.push(issue('constraint_conflict', `${bp}.omega`, '角速度为零则物体静止；圆周运动需非零角速度'));
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['conflict'] };

    const unsupported = scene.asks.filter((a) => ['landing', 'apex', 'rest', 'end_of_support', 'friction_state', 'at_height', 'at_position', 'at_velocity'].includes(a.kind));
    for (const a of unsupported) {
      blockers.push(issue('unsupported_combo', `asks.${a.id}`, '匀速圆周运动模板仅支持指定时刻的状态'));
    }
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['out_of_scope'] };

    if (body.mass === null) pending.push({ path: `${bp}.mass`, label: '质量未赋值：向心力无法计算（其余量与质量无关）' });

    const phase0 = body.phase ?? 0;
    const speed = Math.abs(omega) * r;
    const period = (2 * Math.PI) / Math.abs(omega);
    const accel = (speed * speed) / r;
    const force = body.mass !== null ? body.mass * accel : null;
    const tEnd = period;

    const evalAt = (time: number): Sample => {
      const t = Math.min(Math.max(time, 0), tEnd);
      const th = phase0 + omega * t;
      return {
        t,
        x: cx + r * Math.cos(th),
        y: cy + r * Math.sin(th),
        vx: -r * omega * Math.sin(th),
        vy: r * omega * Math.cos(th),
        s: speed * t,
        u: speed,
      };
    };
    const times = Array.from({ length: 401 }, (_, i) => (tEnd * i) / 400);
    const samples = dedupeNumbers(times).map(evalAt);

    const answers: Answer[] = [
      { id: 'v', label: '线速度大小', value: speed, unit: 'm/s', note: 'v=ωr，方向沿切线' },
      { id: 'omega', label: '角速度', value: Math.abs(omega), unit: 'rad/s' },
      { id: 'T', label: '周期', value: period, unit: 's', note: 'T=2π/ω' },
      { id: 'a', label: '向心加速度', value: accel, unit: 'm/s²', note: 'a=v²/r=ω²r，指向圆心' },
      { id: 'F', label: '向心力', value: force, unit: 'N', note: force === null ? '质量未知，向心力不确定' : 'F=mv²/r，由合外力提供' },
    ];

    const steps: DerivationStep[] = [
      {
        title: '线速度与角速度',
        formula: 'v=\\omega r',
        substitution: `v=${latexNum(Math.abs(omega))}\\times ${latexNum(r)}=${latexNum(speed)}\\ \\mathrm{m/s}`,
      },
      {
        title: '周期',
        formula: 'T=\\frac{2\\pi}{\\omega}',
        substitution: `T=\\frac{2\\pi}{${latexNum(Math.abs(omega))}}=${latexNum(period)}\\ \\mathrm{s}`,
      },
      {
        title: '向心加速度',
        formula: 'a=\\frac{v^2}{r}=\\omega^2 r',
        substitution: `a=\\frac{${latexNum(speed)}^2}{${latexNum(r)}}=${latexNum(accel)}\\ \\mathrm{m/s^2}`,
      },
    ];
    if (force !== null) {
      steps.push({
        title: '向心力',
        formula: 'F=m\\frac{v^2}{r}',
        substitution: `F=${latexNum(body.mass!)}\\times ${latexNum(accel)}=${latexNum(force)}\\ \\mathrm{N}`,
      });
    }
    const formulas = [
      { label: '线速度', latex: 'v=\\omega r' },
      { label: '周期', latex: 'T=\\frac{2\\pi}{\\omega}' },
      { label: '向心加速度', latex: 'a=\\frac{v^2}{r}=\\omega^2 r' },
      { label: '向心力', latex: 'F=m\\frac{v^2}{r}' },
    ];

    for (const ask of scene.asks) {
      if (ask.kind === 'at_time') {
        const t = ask.t!;
        const st = evalAt(t % tEnd);
        answers.push(
          { id: `${ask.id}.x`, label: `t=${fmt(t)} s：位置 x`, value: st.x, unit: 'm' },
          { id: `${ask.id}.y`, label: `t=${fmt(t)} s：位置 y`, value: st.y, unit: 'm' },
          { id: `${ask.id}.v`, label: `t=${fmt(t)} s：速度大小`, value: speed, unit: 'm/s', note: '匀速圆周运动速率不变' },
        );
        steps.push({
          title: `t=${fmt(t)} s 的状态`,
          formula: '\\theta=\\varphi_0+\\omega t,\\quad x=x_c+r\\cos\\theta,\\ y=y_c+r\\sin\\theta',
          substitution: `x=${latexNum(st.x)}\\ \\mathrm{m},\\ y=${latexNum(st.y)}\\ \\mathrm{m}`,
        });
      }
    }

    return {
      ok: true,
      solution: {
        template: 'circular', sceneRev: scene.rev, tEnd,
        stages: [{ label: '匀速圆周运动', t0: 0, t1: tEnd }],
        answers, steps, formulas, samples,
        flags: [],
        evalAt,
        events: [{ kind: 'period', t: tEnd, label: '运动一周' }],
      },
    };
  },
};