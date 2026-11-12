import type { Answer, DerivationStep, Scene } from '../model/types';
import { buildSurfaceTrack, trackLocalToGlobal, trackSegmentAt, trackWorld } from '../model/track';
import { supportDir } from '../model/geometry';
import { fmt } from '../model/units';
import { buildTrack, dedupeNumbers, EPS, latexNum, positiveRoots, quadraticRoots } from './common';
import { runTrack, type Phase } from './alongTrack';
import { issue, missing, type Template } from './template';

export const multiTrackTemplate: Template = {
  id: 'incline-friction',
  match(scene) {
    if (scene.bodies.length !== 1) return false;
    const body = scene.bodies[0];
    if (body.kind !== 'block' || !body.attach) return false;
    return buildSurfaceTrack(scene, body.attach.support).componentSize > 1;
  },
  solve(scene: Scene) {
    const body = scene.bodies[0];
    const track = buildSurfaceTrack(scene, body.attach!.support);
    const pending: Array<{ path: string; label: string }> = [];
    if (track.problems.length) {
      return { ok: false, report: { blockers: track.problems.map((p) => issue('unsupported_combo', p.path, p.message)), pending }, flags: ['out_of_scope'] };
    }

    const hasIncline = track.segments.some((seg) => Math.abs(seg.support.angleDeg ?? 0) > 1e-9);
    const template = hasIncline ? 'incline-friction' : 'kinematics-1d';
    const blockers = [];
    const bp = `bodies.${body.id}`;
    if (body.attach!.s === null) blockers.push(missing(`${bp}.attach.s`, '缺少初始沿面位置'));
    if (body.vel.x === null) blockers.push(missing(`${bp}.vel.x`, '缺少初速度'));
    if (hasIncline && body.accel !== null) blockers.push(issue('unsupported_combo', `${bp}.accel`, '含斜面的连续轨道暂不支持外加加速度；请留空由重力与摩擦决定'));

    const contacts = new Map(track.segments.map((seg) => [seg.support.id, scene.contacts.find((c) => c.body === body.id && c.support === seg.support.id)]));
    for (const seg of track.segments) {
      const contact = contacts.get(seg.support.id);
      const path = contact ? `contacts.${contact.id}` : bp;
      if (!contact) blockers.push(missing(path, `缺少 ${seg.support.name} 的摩擦接触设置`));
      if (hasIncline && Math.abs(seg.support.angleDeg ?? 0) > 1e-9 && (contact?.mu_s === null || contact?.mu_s === undefined)) {
        blockers.push(missing(`${path}.mu_s`, `${seg.support.name} 缺少静摩擦因数；光滑请填 0`));
      }
      if (body.accel === null && (contact?.mu_k === null || contact?.mu_k === undefined)) {
        blockers.push(missing(`${path}.mu_k`, `${seg.support.name} 缺少动摩擦因数；光滑请填 0`));
      }
    }
    const unsupported = scene.asks.filter((a) => ['landing', 'apex', 'at_height'].includes(a.kind) || (!hasIncline && a.kind === 'friction_state'));
    for (const ask of unsupported) blockers.push(issue('unsupported_combo', `asks.${ask.id}`, '连续轨道模板不支持该待求量'));
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['insufficient'] };

    const g = scene.gravity!;
    const s0 = trackLocalToGlobal(track, body.attach!.support, body.attach!.s!)!;
    const initialSeg = trackSegmentAt(track, s0);
    const u0 = (body.vel.x ?? 0) * initialSeg.dir.x + (body.vel.y ?? 0) * initialSeg.dir.y;
    const aGiven = body.accel;

    const decide = ({ s, u }: { s: number; u: number }): Phase => {
      const seg = trackSegmentAt(track, s, u);
      const contact = contacts.get(seg.support.id)!;
      const sin = seg.dir.y;
      const cos = Math.abs(supportDir(seg.support).x);
      const muS = contact.mu_s ?? 0;
      const muK = contact.mu_k ?? 0;
      const name = seg.support.name;
      if (!hasIncline && aGiven !== null) return { a: aGiven, label: `${name}：匀变速直线运动`, note: '加速度为已知条件' };
      if (Math.abs(u) > EPS) {
        return {
          a: -g * sin - Math.sign(u) * muK * g * cos,
          label: `${name}：沿轨道${u > 0 ? '正向' : '反向'}滑动`,
          note: '重力沿轨分量与滑动摩擦共同决定加速度',
        };
      }
      if (Math.abs(sin) <= muS * cos + EPS) {
        return { a: 0, static: true, label: `${name}：静止`, note: '静摩擦足以平衡沿轨方向合力' };
      }
      return {
        a: -Math.sign(sin) * g * (Math.abs(sin) - muK * cos),
        label: `${name}：由静止开始滑动`,
        note: '静摩擦不足以维持静止',
      };
    };

    const maxAskTime = Math.max(0, ...scene.asks.map((a) => a.t ?? 0));
    const window = Math.max(6, maxAskTime * 1.2);
    const result = runTrack({ s0, u0, length: track.length, junctions: track.junctions, decide, window });
    const built = buildTrack(result.stages, result.tEnd, (s, u) => trackWorld(track, s, u));

    const answers: Answer[] = [];
    const a0 = result.stages[0]?.a ?? 0;
    answers.push({ id: 'accel', label: '首段加速度（沿轨）', value: a0, unit: 'm/s²', note: '质量可约去' });
    if (hasIncline) {
      const seg = initialSeg;
      const contact = contacts.get(seg.support.id)!;
      const sin = seg.dir.y;
      const cos = Math.abs(supportDir(seg.support).x);
      const staticState = Math.abs(u0) <= EPS && Math.abs(sin) <= (contact.mu_s ?? 0) * cos + EPS;
      answers.push({
        id: 'friction', label: '初始摩擦与运动状态', value: null, unit: '',
        text: staticState ? `${seg.support.name} 上静摩擦自锁，物体保持静止` : `${seg.support.name} 上物体滑动；首段加速度 a=${fmt(a0)} m/s²`,
      });
    }

    const steps: DerivationStep[] = [
      {
        title: '连续轨道分段',
        formula: 's_{i+1}=s_i+L_i,\\quad \\hat t_i=\\text{第 }i\\text{ 段切向单位矢量}',
        substitution: track.segments.map((seg, i) => `\\text{${i + 1}. ${seg.support.name}}: L=${latexNum(seg.length)}\\ \\mathrm{m},\\ \\theta=${latexNum(seg.support.angleDeg ?? 0)}^{\\circ}`).join(';\\quad '),
        note: '端点重合的支撑面按几何顺序组成一条轨道；内部连接点不截断运动。',
      },
    ];
    for (const seg of track.segments) {
      const contact = contacts.get(seg.support.id)!;
      const sin = seg.dir.y;
      const cos = Math.abs(supportDir(seg.support).x);
      const muK = contact.mu_k ?? 0;
      steps.push({
        title: `${seg.support.name} 的沿轨加速度`,
        formula: 'a=-g\\sin\\theta-\\operatorname{sgn}(u)\\mu_k g\\cos\\theta',
        substitution: `\\sin\\theta=${latexNum(sin)},\\ \\cos\\theta=${latexNum(cos)},\\ \\mu_k=${latexNum(muK)} \\Rightarrow u>0: a=${latexNum(-g * sin - muK * g * cos)},\\ u<0: a=${latexNum(-g * sin + muK * g * cos)}`,
        note: '每段使用自己的倾角与摩擦因数；静止时先检查 |tanθ| ≤ μ_s。',
      });
    }
    const junctionEvents = result.events.filter((e) => e.kind === 'junction');
    if (junctionEvents.length) {
      steps.push({
        title: '连接点处的速度连续',
        formula: 'u(t_j^-)=u(t_j^+),\\quad \\vec v(t_j^+)=u(t_j)\\hat t_{j+1}',
        substitution: junctionEvents.map((e) => `t_j=${latexNum(e.t)}\\ \\mathrm{s},\\ |u|=${latexNum(Math.abs(built.evalAt(e.t).u ?? 0))}\\ \\mathrm{m/s}`).join(';\\quad '),
        note: '理想光滑连接：速率连续，速度方向随下一段切线改变；不额外引入碰撞能量损失。',
      });
    }

    const endEvent = result.events.find((e) => e.kind === 'end_of_support');
    if (endEvent) {
      const st = built.evalAt(endEvent.t);
      answers.push(
        { id: 'end_t', label: '到达轨道端点的时间', value: endEvent.t, unit: 's', note: endEvent.label },
        { id: 'end_v', label: '到达端点时的速率', value: hasIncline ? Math.abs(st.u ?? 0) : st.vx, unit: 'm/s', note: `沿轨位置 s=${fmt(endEvent.s)} m，运动截至外端点` },
      );
      steps.push({
        title: '到达轨道外端点',
        formula: 's=s_0+u_0 t+\\frac{1}{2}a t^2,\\quad u=u_0+a t',
        substitution: `t=${latexNum(endEvent.t)}\\ \\mathrm{s},\\ s=${latexNum(endEvent.s)}\\ \\mathrm{m}`,
      });
    } else {
      answers.push({ id: 'end_t', label: '到达轨道端点的时间', value: null, unit: 's', note: `在 ${fmt(result.tEnd)} s 观察窗内未到达外端点` });
    }
    const restEvent = result.events.find((e) => e.kind === 'rest');
    if (restEvent) {
      const st = built.evalAt(restEvent.t);
      answers.push(
        { id: 'rest_t', label: '速度为零的时刻', value: restEvent.t, unit: 's' },
        { id: 'rest_x', label: '速度为零时的位置 x', value: st.x, unit: 'm', note: `沿轨位置 s=${fmt(restEvent.s)} m` },
      );
    }

    const flags = new Set<'multi'>();
    for (const ask of scene.asks) {
      if (ask.kind === 'at_time') {
        const t = ask.t!;
        if (t > result.tEnd + EPS) {
          answers.push({ id: ask.id, label: `t=${fmt(t)} s 的状态`, value: null, unit: '', note: '该时刻在运动结束之后' });
          continue;
        }
        const st = built.evalAt(t);
        answers.push(
          { id: `${ask.id}.s`, label: `t=${fmt(t)} s：沿轨位置 s`, value: st.s, unit: 'm' },
          { id: `${ask.id}.u`, label: `t=${fmt(t)} s：沿轨速度 u`, value: st.u ?? 0, unit: 'm/s' },
          { id: `${ask.id}.x`, label: `t=${fmt(t)} s：位置 x`, value: st.x, unit: 'm' },
          { id: `${ask.id}.y`, label: `t=${fmt(t)} s：高度 y`, value: st.y, unit: 'm' },
        );
      }
      if (ask.kind === 'at_position') {
        const target = ask.x!;
        const roots: number[] = [];
        for (const se of result.stages) {
          for (const r of positiveRoots(quadraticRoots(0.5 * se.a, se.u0, se.s0 - target))) {
            const abs = se.stage.t0 + r;
            if (abs <= se.stage.t1 + EPS) roots.push(abs);
          }
        }
        const times = dedupeNumbers(roots).filter((t) => t <= result.tEnd + EPS);
        if (times.length > 1) flags.add('multi');
        answers.push({
          id: ask.id, label: `到达沿轨 s=${fmt(target)} m 的时刻`, value: times[0] ?? null, unit: 's',
          others: times.slice(1).map((r) => ({ value: r, unit: 's' })),
          note: times.length === 0 ? '运动范围内不经过该沿轨位置' : times.length > 1 ? '多次经过同一位置，属于多解' : undefined,
        });
      }
      if (ask.kind === 'at_velocity') {
        const target = ask.v!;
        const times: number[] = [];
        for (const se of result.stages) {
          if (Math.abs(se.a) < EPS) continue;
          const r = (target - se.u0) / se.a;
          const abs = se.stage.t0 + r;
          if (r > EPS && abs <= se.stage.t1 + EPS) times.push(abs);
        }
        answers.push({
          id: ask.id, label: `沿轨速度达到 ${fmt(target)} m/s 的时刻`, value: times[0] ?? null, unit: 's',
          others: times.slice(1).map((r) => ({ value: r, unit: 's' })),
          note: times.length === 0 ? '运动范围内不会出现该速度' : undefined,
        });
      }
    }

    return {
      ok: true,
      solution: {
        template, sceneRev: scene.rev, tEnd: result.tEnd,
        stages: built.stages, answers, steps,
        formulas: [
          { label: '沿轨运动学', latex: 's=s_0+u_0 t+\\frac{1}{2}a t^2,\\quad u=u_0+a t' },
          { label: '分段加速度', latex: 'a_i=-g\\sin\\theta_i-\\operatorname{sgn}(u)\\mu_{k,i}g\\cos\\theta_i' },
          { label: '连接点连续', latex: 'u(t_j^-)=u(t_j^+)' },
        ],
        samples: built.samples, flags: [...flags], evalAt: built.evalAt,
        events: result.events.map((e) => ({ kind: e.kind, t: e.t, label: e.label })),
      },
    };
  },
};
