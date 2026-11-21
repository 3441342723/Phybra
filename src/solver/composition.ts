import type { Answer, DerivationStep, Sample, Scene } from '../model/types';
import { fmt } from '../model/units';
import { dedupeNumbers, EPS, latexNum } from './common';
import { issue, missing, type Template } from './template';

export const compositionTemplate: Template = {
  id: 'composition',
  match: (scene) => scene.bodies.length === 1 && scene.bodies[0].kind === 'boat',
  solve(scene: Scene) {
    const body = scene.bodies[0];
    const blockers = [];
    const pending: Array<{ path: string; label: string }> = [];
    const bp = `bodies.${body.id}`;
    const flow = body.flow ?? { x: null, y: null };
    for (const [path, value, label] of [
      [`${bp}.pos.x`, body.pos.x, '出发点 x'],
      [`${bp}.pos.y`, body.pos.y, '出发点 y（近岸）'],
      [`${bp}.vel.x`, body.vel.x, '船相对水的速度 x 分量'],
      [`${bp}.vel.y`, body.vel.y, '船相对水的速度 y 分量'],
      [`${bp}.flow.x`, flow.x, '水流速度 x 分量'],
      [`${bp}.flow.y`, flow.y, '水流速度 y 分量'],
      [`${bp}.width`, body.width, '河宽'],
    ] as const) {
      if (value === null) blockers.push(missing(path, `缺少${label}`));
    }
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['insufficient'] };

    const x0 = body.pos.x!;
    const y0 = body.pos.y!;
    const bvx = body.vel.x!;
    const bvy = body.vel.y!;
    const fx = flow.x!;
    const fy = flow.y!;
    const width = body.width!;
    if (width <= 0) blockers.push(issue('constraint_conflict', `${bp}.width`, '河宽必须为正'));
    const Vx = bvx + fx;
    const Vy = bvy + fy;
    if (Vy <= EPS) blockers.push(issue('constraint_conflict', `${bp}.vel.y`, '合速度沿河宽方向的分量必须为正，否则船无法到达对岸'));
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['conflict'] };

    const unsupported = scene.asks.filter((a) => ['apex', 'rest', 'end_of_support', 'friction_state', 'at_height', 'at_velocity'].includes(a.kind));
    for (const a of unsupported) {
      blockers.push(issue('unsupported_combo', `asks.${a.id}`, '小船渡河模板不支持该待求量'));
    }
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['out_of_scope'] };

    const vBoat = Math.hypot(bvx, bvy);
    const vFlow = Math.hypot(fx, fy);
    const vResult = Math.hypot(Vx, Vy);
    const tCross = width / Vy;
    const drift = Vx * tCross;
    const landX = x0 + drift;
    const tMin = vBoat > EPS ? width / vBoat : null;
    // 最短位移：船速不小于水速时可垂直渡河（位移=河宽）；否则最短位移为河宽×水速/船速
    const minDisp = vBoat > EPS ? (vBoat >= vFlow ? width : (width * vFlow) / vBoat) : null;

    const evalAt = (time: number): Sample => {
      const t = Math.min(Math.max(time, 0), tCross);
      return { t, x: x0 + Vx * t, y: y0 + Vy * t, vx: Vx, vy: Vy, s: vResult * t, u: vResult };
    };
    const times = Array.from({ length: 401 }, (_, i) => (tCross * i) / 400);
    const samples = dedupeNumbers(times).map(evalAt);

    const answers: Answer[] = [
      { id: 'cross_t', label: '渡河时间', value: tCross, unit: 's', note: '由合速度沿河宽分量决定：t=d/v_y' },
      { id: 'cross_drift', label: '沿河漂移距离', value: drift, unit: 'm', note: `到达对岸时 x=${fmt(landX)} m` },
      { id: 'cross_v', label: '合速度大小', value: vResult, unit: 'm/s', note: `分量 v_x=${fmt(Vx)} m/s，v_y=${fmt(Vy)} m/s` },
    ];
    if (tMin !== null) {
      answers.push({ id: 'min_t', label: '最短渡河时间', value: tMin, unit: 's', note: '船头垂直河岸时取得，与水流速度无关' });
    }
    if (minDisp !== null) {
      answers.push({
        id: 'min_disp', label: '最短渡河位移', value: minDisp, unit: 'm',
        note: vBoat >= vFlow ? '船速≥水速，可垂直渡河，位移等于河宽' : '船速<水速，无法垂直渡河；最短位移=河宽×水速/船速',
      });
    }

    const steps: DerivationStep[] = [
      {
        title: '运动合成（船相对水 + 水相对岸）',
        formula: 'v_x=v_{船x}+v_{水x},\\quad v_y=v_{船y}+v_{水y}',
        substitution: `v_x=${latexNum(bvx)}+${latexNum(fx)}=${latexNum(Vx)},\\quad v_y=${latexNum(bvy)}+${latexNum(fy)}=${latexNum(Vy)}`,
        note: '两个方向的匀速直线运动合成，合运动仍为匀速直线运动，共用同一时间 t。',
      },
      {
        title: '渡河时间（沿河宽方向）',
        formula: 't=\\frac{d}{v_y}',
        substitution: `t=\\frac{${latexNum(width)}}{${latexNum(Vy)}}=${latexNum(tCross)}\\ \\mathrm{s}`,
      },
      {
        title: '沿河漂移与合速度',
        formula: 'x=v_x t,\\quad v=\\sqrt{v_x^2+v_y^2}',
        substitution: `x=${latexNum(Vx)}\\times ${latexNum(tCross)}=${latexNum(drift)}\\ \\mathrm{m},\\quad v=${latexNum(vResult)}\\ \\mathrm{m/s}`,
      },
    ];
    const formulas = [
      { label: '合速度分量', latex: 'v_x=v_{船x}+v_{水x},\\ v_y=v_{船y}+v_{水y}' },
      { label: '渡河时间', latex: 't=\\frac{d}{v_y}' },
      { label: '最短时间', latex: 't_{min}=\\frac{d}{v_{船}}\\ (船头垂直河岸)' },
    ];

    const flags = new Set<'multi'>();
    for (const ask of scene.asks) {
      if (ask.kind === 'at_time') {
        const t = ask.t!;
        if (t > tCross + EPS) {
          answers.push({ id: ask.id, label: `t=${fmt(t)} s 时的状态`, value: null, unit: '', note: '该时刻船已到达对岸' });
          continue;
        }
        const st = evalAt(t);
        answers.push(
          { id: `${ask.id}.x`, label: `t=${fmt(t)} s：位置 x`, value: st.x, unit: 'm' },
          { id: `${ask.id}.y`, label: `t=${fmt(t)} s：位置 y`, value: st.y, unit: 'm' },
          { id: `${ask.id}.v`, label: `t=${fmt(t)} s：速度大小`, value: vResult, unit: 'm/s' },
        );
        steps.push({
          title: `t=${fmt(t)} s 的状态`,
          formula: 'x=x_0+v_x t,\\ y=y_0+v_y t',
          substitution: `x=${latexNum(st.x)}\\ \\mathrm{m},\\ y=${latexNum(st.y)}\\ \\mathrm{m}`,
        });
      }
      if (ask.kind === 'landing') {
        answers.push(
          { id: `${ask.id}.t`, label: '到达对岸时间', value: tCross, unit: 's' },
          { id: `${ask.id}.x`, label: '到达对岸位置 x', value: landX, unit: 'm' },
        );
      }
      if (ask.kind === 'at_position') {
        const X = ask.x!;
        if (Math.abs(Vx) < EPS) {
          answers.push({ id: ask.id, label: `到达 x=${fmt(X)} m 的时刻`, value: null, unit: 's', note: '合速度 x 分量为 0，x 不变' });
        } else {
          const t = (X - x0) / Vx;
          const valid = t > EPS && t <= tCross + EPS;
          answers.push({ id: ask.id, label: `到达 x=${fmt(X)} m 的时刻`, value: valid ? t : null, unit: 's', note: valid ? undefined : '该位置不在渡河过程中' });
        }
      }
    }

    return {
      ok: true,
      solution: {
        template: 'composition', sceneRev: scene.rev, tEnd: tCross,
        stages: [{ label: '匀速渡河', t0: 0, t1: tCross }],
        answers, steps, formulas, samples,
        flags: [...flags],
        evalAt,
        events: [{ kind: 'landing', t: tCross, label: '到达对岸' }],
      },
    };
  },
};