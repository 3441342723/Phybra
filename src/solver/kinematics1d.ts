import type { Answer, DerivationStep, Scene } from '../model/types';
import { fmt } from '../model/units';
import { buildTrack, dedupeNumbers, EPS, latexNum, positiveRoots, quadraticRoots } from './common';
import { runTrack, type Phase } from './alongTrack';
import { supportLength } from '../model/geometry';
import { issue, missing, type Template } from './template';

export const kinematicsTemplate: Template = {
  id: 'kinematics-1d',
  match(scene) {
    if (scene.bodies.length !== 1) return false;
    const b = scene.bodies[0];
    if (b.kind !== 'block' || !b.attach) return false;
    const sup = scene.supports.find((s) => s.id === b.attach!.support);
    return !!sup && Math.abs(sup.angleDeg ?? 0) <= 1e-9;
  },
  solve(scene: Scene) {
    const body = scene.bodies[0];
    const sup = scene.supports.find((s) => s.id === body.attach!.support)!;
    const contact = scene.contacts.find((c) => c.body === body.id);
    const blockers = [];
    const pending: Array<{ path: string; label: string }> = [];
    const bp = `bodies.${body.id}`;
    if (body.attach!.s === null) blockers.push(missing(`${bp}.attach.s`, '缺少初始位置'));
    if (body.vel.x === null) blockers.push(missing(`${bp}.vel.x`, '缺少初速度'));
    const useFriction = body.accel === null;
    if (useFriction && (contact?.mu_k === null || contact?.mu_k === undefined)) {
      blockers.push(missing(`contacts.${contact?.id ?? body.id}.mu_k`, '未给加速度时需要动摩擦因数；匀速或光滑请把 μ 填为 0，或直接填写加速度'));
    }
    const unsupported = scene.asks.filter((a) => ['landing', 'apex', 'at_height', 'friction_state'].includes(a.kind));
    for (const a of unsupported) blockers.push(issue('unsupported_combo', `asks.${a.id}`, '直线运动模板不支持该待求量'));
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: [useFriction ? 'insufficient' : 'out_of_scope'] };

    const g = scene.gravity!;
    const muK = contact?.mu_k ?? 0;
    const aGiven = body.accel;
    const s0 = body.attach!.s!;
    const u0 = body.vel.x!;
    const L = supportLength(sup);
    const decide = ({ u }: { s: number; u: number }): Phase => {
      if (aGiven !== null) return { a: aGiven, label: '匀变速直线运动', note: '加速度为已知条件' };
      if (Math.abs(u) <= EPS) return { a: 0, static: true, label: '静止', note: '无驱动力，滑动停止后保持静止' };
      return { a: -Math.sign(u) * muK * g, label: muK === 0 ? '匀速直线运动（光滑）' : '滑动摩擦减速', note: 'a = -sgn(v)·μ_k g' };
    };
    const maxAskTime = Math.max(0, ...scene.asks.map((a) => a.t ?? 0));
    const window = Math.max(6, maxAskTime * 1.2);
    const track = runTrack({ s0, u0, length: L, decide, window });
    const built = buildTrack(track.stages, track.tEnd, (s, u) => ({ x: sup.a.x + s, y: sup.a.y, vx: u, vy: 0 }));

    const answers: Answer[] = [];
    const a0 = track.stages[0]?.a ?? 0;
    answers.push({ id: 'accel', label: '加速度', value: a0, unit: 'm/s²', note: useFriction ? '由滑动摩擦产生' : '已知条件' });
    const steps: DerivationStep[] = [
      useFriction
        ? {
            title: '由摩擦确定加速度',
            formula: 'N=m g,\\quad f=\\mu_k N,\\quad a=-\\operatorname{sgn}(v)\\frac{f}{m}=-\\operatorname{sgn}(v)\\mu_k g',
            substitution: `a=-\\operatorname{sgn}(${latexNum(u0)})\\times ${latexNum(muK)}\\times ${latexNum(g)}=${latexNum(a0)}\\ \\mathrm{m/s^2}`,
            note: '质量可约去。',
          }
        : {
            title: '加速度为已知条件',
            formula: 'a=\\text{const}',
            substitution: `a=${latexNum(a0)}\\ \\mathrm{m/s^2}`,
          },
      {
        title: '匀变速运动学',
        formula: 'x=x_0+v_0 t+\\frac{1}{2}a t^2,\\quad v=v_0+a t,\\quad v^2-v_0^2=2a(x-x_0)',
        substitution: `x_0=${latexNum(sup.a.x + s0)}\\ \\mathrm{m},\\ v_0=${latexNum(u0)}\\ \\mathrm{m/s}`,
      },
    ];
    const formulas = [
      { label: '速度', latex: 'v=v_0+a t' },
      { label: '位移', latex: 'x=x_0+v_0 t+\\frac{1}{2}a t^2' },
      { label: '速度位移关系', latex: 'v^2-v_0^2=2a(x-x_0)' },
    ];
    if (useFriction) formulas.push({ label: '摩擦加速度', latex: 'a=-\\operatorname{sgn}(v)\\mu_k g' });

    const restEvent = track.events.find((e) => e.kind === 'rest');
    if (restEvent) {
      answers.push(
        { id: 'rest_t', label: '速度为零的时刻', value: restEvent.t, unit: 's' },
        { id: 'rest_x', label: '速度为零时的位置', value: sup.a.x + restEvent.s, unit: 'm', note: `相对起点位移 ${fmt(restEvent.s - s0)} m` },
      );
      steps.push({
        title: '速度为零',
        formula: 't=\\frac{-v_0}{a},\\quad x=x_0+v_0 t+\\frac{1}{2}a t^2',
        substitution: `t=${latexNum(restEvent.t)}\\ \\mathrm{s}`,
        note: aGiven !== null ? '加速度仍由外部给定，之后可能反向运动' : '摩擦力消失，物体保持静止',
      });
    }
    const endEvent = track.events.find((e) => e.kind === 'end_of_support');
    if (endEvent) {
      const st = built.evalAt(endEvent.t);
      answers.push(
        { id: 'end_t', label: '到达水平面端点的时间', value: endEvent.t, unit: 's', note: endEvent.label },
        { id: 'end_v', label: '到达端点时的速度', value: st.vx, unit: 'm/s' },
      );
    }

    const flags = new Set<'multi'>();
    for (const ask of scene.asks) {
      if (ask.kind === 'at_time') {
        const t = ask.t!;
        if (t > track.tEnd + EPS) {
          answers.push({ id: ask.id, label: `t=${fmt(t)} s 的状态`, value: null, unit: '', note: '该时刻在运动结束之后' });
          continue;
        }
        const st = built.evalAt(t);
        answers.push(
          { id: `${ask.id}.x`, label: `t=${fmt(t)} s：位置 x`, value: st.x, unit: 'm' },
          { id: `${ask.id}.v`, label: `t=${fmt(t)} s：速度 v`, value: st.vx, unit: 'm/s' },
        );
        steps.push({
          title: `t=${fmt(t)} s 的状态`,
          formula: 'x=x_0+v_0 t+\\frac{1}{2}a t^2,\\quad v=v_0+a t',
          substitution: `x=${latexNum(st.x)}\\ \\mathrm{m},\\quad v=${latexNum(st.vx)}\\ \\mathrm{m/s}`,
        });
      }
      if (ask.kind === 'at_position') {
        const X = ask.x! - sup.a.x;
        const roots: number[] = [];
        for (const se of track.stages) {
          for (const r of positiveRoots(quadraticRoots(0.5 * se.a, se.u0, se.s0 - X))) {
            const abs = se.stage.t0 + r;
            if (abs <= se.stage.t1 + EPS) roots.push(abs);
          }
        }
        const times = dedupeNumbers(roots).filter((t) => t <= track.tEnd + EPS);
        if (times.length > 1) flags.add('multi');
        answers.push({
          id: ask.id, label: `到达 x=${fmt(ask.x!)} m 的时刻`, value: times[0] ?? null, unit: 's',
          others: times.slice(1).map((r) => ({ value: r, unit: 's' })),
          note: times.length === 0 ? '运动范围内不经过该位置' : times.length > 1 ? '往返运动会多次经过，属于多解' : undefined,
        });
      }
      if (ask.kind === 'at_velocity') {
        const V = ask.v!;
        const times: number[] = [];
        for (const se of track.stages) {
          if (Math.abs(se.a) < EPS) continue;
          const r = (V - se.u0) / se.a;
          const abs = se.stage.t0 + r;
          if (r > EPS && abs <= se.stage.t1 + EPS) times.push(abs);
        }
        answers.push({
          id: ask.id, label: `速度达到 ${fmt(V)} m/s 的时刻`, value: times[0] ?? null, unit: 's',
          others: times.slice(1).map((r) => ({ value: r, unit: 's' })),
          note: times.length === 0 ? '运动范围内不会出现该速度' : undefined,
        });
      }
    }

    return {
      ok: true,
      solution: {
        template: 'kinematics-1d', sceneRev: scene.rev, tEnd: track.tEnd,
        stages: built.stages, answers, steps, formulas, samples: built.samples,
        flags: [...flags], evalAt: built.evalAt,
        events: track.events.map((e) => ({ kind: e.kind, t: e.t, label: e.label })),
      },
    };
  },
};
