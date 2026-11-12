import type { Answer, DerivationStep, Scene } from '../model/types';
import { fmt } from '../model/units';
import { buildTrack, dedupeNumbers, EPS, latexNum, positiveRoots, quadraticRoots } from './common';
import { runTrack, type Phase } from './alongTrack';
import { supportDir, supportLength } from '../model/geometry';
import { issue, missing, type Template } from './template';

export const inclineTemplate: Template = {
  id: 'incline-friction',
  match(scene) {
    if (scene.bodies.length !== 1) return false;
    const b = scene.bodies[0];
    if (b.kind !== 'block' || !b.attach) return false;
    const sup = scene.supports.find((s) => s.id === b.attach!.support);
    return !!sup && Math.abs(sup.angleDeg ?? 0) > 1e-9;
  },
  solve(scene: Scene) {
    const body = scene.bodies[0];
    const sup = scene.supports.find((s) => s.id === body.attach!.support)!;
    const contact = scene.contacts.find((c) => c.body === body.id);
    const blockers = [];
    const pending: Array<{ path: string; label: string }> = [];
    const bp = `bodies.${body.id}`;
    if (body.attach!.s === null) blockers.push(missing(`${bp}.attach.s`, '缺少物体在斜面上的初始位置（沿面距离）'));
    if (body.vel.x === null) blockers.push(missing(`${bp}.vel.x`, '缺少初速度（沿斜面为正方向，静止填 0）'));
    if (contact?.mu_s === null || contact?.mu_s === undefined) blockers.push(missing(`contacts.${contact?.id ?? body.id}.mu_s`, '缺少静摩擦因数；光滑请填 0'));
    const g = scene.gravity!;
    const theta = (sup.angleDeg! * Math.PI) / 180;
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    const muS = contact?.mu_s ?? 0;
    const s0 = body.attach!.s ?? 0;
    const u0 = (body.vel.x ?? 0) * Math.cos(theta) + (body.vel.y ?? 0) * Math.sin(theta);
    const slidesFromRest = Math.abs(sin) > muS * cos + EPS;
    const willMove = Math.abs(u0) > EPS || slidesFromRest;
    if (willMove && (contact?.mu_k === null || contact?.mu_k === undefined)) {
      blockers.push(missing(`contacts.${contact?.id ?? body.id}.mu_k`, '物体将发生滑动，缺少动摩擦因数；光滑请填 0'));
    }
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['insufficient'] };

    const muK = contact?.mu_k ?? 0;
    const L = supportLength(sup);
    const dir = supportDir(sup);
    const aUp = -g * sin - muK * g * cos;
    const aDown = -g * sin + muK * g * cos;
    const aFromRest = -Math.sign(sin) * g * (Math.abs(sin) - muK * cos);

    const decide = ({ u }: { s: number; u: number }): Phase => {
      if (u > EPS) return { a: -g * sin - Math.sign(u) * muK * g * cos, label: '沿斜面向上运动', note: '重力分量与摩擦力均沿斜面向下' };
      if (u < -EPS) return { a: -g * sin - Math.sign(u) * muK * g * cos, label: '沿斜面向下运动', note: '摩擦力沿斜面向上' };
      if (Math.abs(sin) <= muS * cos + EPS) return { a: 0, static: true, label: '静止（静摩擦自锁）', note: '|tanθ| ≤ μ_s，静摩擦足以平衡重力分量' };
      return { a: aFromRest, label: '由静止开始滑动', note: '|tanθ| > μ_s，静摩擦不足以维持静止' };
    };

    const maxAskTime = Math.max(0, ...scene.asks.map((a) => a.t ?? 0));
    const window = Math.max(6, maxAskTime * 1.2);
    const track = runTrack({ s0, u0, length: L, decide, window });
    const built = buildTrack(track.stages, track.tEnd, (s, u) => ({
      x: sup.a.x + s * dir.x, y: sup.a.y + s * dir.y, vx: u * dir.x, vy: u * dir.y,
    }));

    const unsupported = scene.asks.filter((a) => ['landing', 'apex'].includes(a.kind));
    if (unsupported.length) {
      return {
        ok: false,
        report: { blockers: unsupported.map((a) => issue('unsupported_combo', `asks.${a.id}`, '斜面模板不支持落地/最高点等待求量')), pending },
        flags: ['out_of_scope'],
      };
    }

    const answers: Answer[] = [];
    const crit = Math.abs(Math.tan(theta));
    const staticState = Math.abs(u0) <= EPS && !slidesFromRest;
    answers.push({
      id: 'friction', label: '摩擦与运动状态', value: null, unit: '',
      text: staticState
        ? `|tanθ|=${fmt(crit)} ≤ μ_s=${fmt(muS)}，静摩擦自锁，物体保持静止`
        : `|tanθ|=${fmt(crit)} > μ_s=${fmt(muS)}（或已有初速度），物体滑动；首段加速度 a=${fmt(track.stages[0]?.a ?? 0)} m/s²`,
    });
    answers.push({ id: 'accel', label: '首段加速度（沿面）', value: track.stages[0]?.a ?? 0, unit: 'm/s²', note: '质量可约去，结果与 m 无关' });

    const steps: DerivationStep[] = [
      {
        title: '正交分解与法向平衡',
        formula: 'N=m g\\cos\\theta,\\quad |f|\\le \\mu_s N\\ (静止),\\quad f_k=\\mu_k N\\ (滑动)',
        substitution: `\\theta=${latexNum(sup.angleDeg!)}^{\\circ},\\ \\sin\\theta=${latexNum(sin)},\\ \\cos\\theta=${latexNum(cos)}`,
        note: '沿面与垂直面两个方向分解；垂直面方向无加速度。',
      },
      {
        title: '临界判断：能否保持静止',
        formula: '|m g\\sin\\theta|\\le \\mu_s m g\\cos\\theta \\iff |\\tan\\theta|\\le\\mu_s',
        substitution: `|\\tan\\theta|=${latexNum(crit)},\\ \\mu_s=${latexNum(muS)} \\Rightarrow ${staticState ? '保持静止' : '不能保持静止'}`,
      },
    ];
    if (willMove) {
      steps.push({
        title: '滑动后的沿面方程（质量约去）',
        formula: 'a=-g\\sin\\theta-\\operatorname{sgn}(u)\\,\\mu_k g\\cos\\theta',
        substitution: `u>0:\\ a=${latexNum(aUp)}\\ \\mathrm{m/s^2};\\quad u<0:\\ a=${latexNum(aDown)}\\ \\mathrm{m/s^2};\\quad 由静止下滑:\\ a=${latexNum(aFromRest)}\\ \\mathrm{m/s^2}`,
        note: '摩擦力总是与相对运动方向相反，因此上行与下行的加速度不同。',
      });
    }
    const formulas = [
      { label: '法向支持力', latex: 'N=m g\\cos\\theta' },
      { label: '静止条件', latex: '|\\tan\\theta|\\le\\mu_s' },
      { label: '滑动加速度', latex: 'a=-g\\sin\\theta-\\operatorname{sgn}(u)\\mu_k g\\cos\\theta' },
      { label: '沿面运动学', latex: 's=s_0+u_0 t+\\frac{1}{2}a t^2,\\quad u=u_0+a t' },
    ];

    const endEvent = track.events.find((e) => e.kind === 'end_of_support');
    if (endEvent) {
      const st = built.evalAt(endEvent.t);
      const uEnd = st.vx * dir.x + st.vy * dir.y;
      answers.push(
        { id: 'end_t', label: '到达端点的时间', value: endEvent.t, unit: 's', note: endEvent.label },
        { id: 'end_v', label: '到达端点时的速率', value: Math.abs(uEnd), unit: 'm/s', note: `沿面位置 s=${fmt(endEvent.s)} m，运动截至端点` },
      );
      steps.push({
        title: '到达端点（运动截断）',
        formula: 's=s_0+u_0 t+\\frac{1}{2}a t^2,\\quad u=u_0+a t',
        substitution: `t=${latexNum(endEvent.t)}\\ \\mathrm{s},\\ |u|=${latexNum(Math.abs(uEnd))}\\ \\mathrm{m/s}`,
      });
    } else if (staticState) {
      answers.push({ id: 'end_t', label: '到达端点的时间', value: null, unit: 's', note: '物体静止，不会到达端点' });
    } else {
      answers.push({ id: 'end_t', label: '到达端点的时间', value: null, unit: 's', note: `在 ${fmt(track.tEnd)} s 观察窗内未到达端点（可能先停下）` });
    }
    const restEvent = track.events.find((e) => e.kind === 'rest');
    if (restEvent) {
      answers.push({ id: 'rest_t', label: '速度为零的时刻', value: restEvent.t, unit: 's', note: `沿面位置 s=${fmt(restEvent.s)} m` });
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
        const u = st.vx * dir.x + st.vy * dir.y;
        answers.push(
          { id: `${ask.id}.s`, label: `t=${fmt(t)} s：沿面位置 s`, value: st.s, unit: 'm' },
          { id: `${ask.id}.u`, label: `t=${fmt(t)} s：沿面速度 u`, value: u, unit: 'm/s' },
        );
      }
      if (ask.kind === 'at_position') {
        const X = ask.x!;
        const roots: number[] = [];
        for (const se of track.stages) {
          for (const r of positiveRoots(quadraticRoots(0.5 * se.a, se.u0, se.s0 - X))) {
            const abs = se.stage.t0 + r;
            if (r >= -EPS && abs <= se.stage.t1 + EPS) roots.push(abs);
          }
        }
        const times = dedupeNumbers(roots).filter((t) => t <= track.tEnd + EPS);
        if (times.length > 1) flags.add('multi');
        answers.push({
          id: ask.id, label: `到达 s=${fmt(X)} m 的时刻`, value: times[0] ?? null, unit: 's',
          others: times.slice(1).map((r) => ({ value: r, unit: 's' })),
          note: times.length === 0 ? '运动范围内不经过该位置' : times.length > 1 ? '多次经过同一位置（往返），属于多解' : undefined,
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
          id: ask.id, label: `沿面速度达到 ${fmt(V)} m/s 的时刻`, value: times[0] ?? null, unit: 's',
          others: times.slice(1).map((r) => ({ value: r, unit: 's' })),
          note: times.length === 0 ? '运动范围内不会出现该速度' : undefined,
        });
      }
    }

    return {
      ok: true,
      solution: {
        template: 'incline-friction', sceneRev: scene.rev, tEnd: track.tEnd,
        stages: built.stages, answers, steps, formulas, samples: built.samples,
        flags: [...flags], evalAt: built.evalAt,
        events: track.events.map((e) => ({ kind: e.kind, t: e.t, label: e.label })),
      },
    };
  },
};
