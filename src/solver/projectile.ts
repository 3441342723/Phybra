import type { Answer, DerivationStep, Sample, Scene, Support } from '../model/types';
import { fmt } from '../model/units';
import { supportDir, supportLength } from '../model/geometry';
import { dedupeNumbers, EPS, latexNum, positiveRoots, quadraticRoots } from './common';
import { issue, missing, type Template } from './template';
import { withEnergy } from './energy';

export const projectileTemplate: Template = {
  id: 'projectile',
  match: (scene) => scene.bodies.length === 1 && scene.bodies[0].kind === 'projectile',
  solve(scene: Scene) {
    const body = scene.bodies[0];
    const blockers = [];
    const pending: Array<{ path: string; label: string }> = [];
    const bp = `bodies.${body.id}`;
    for (const [path, value, label] of [
      [`${bp}.pos.x`, body.pos.x, '初始 x'],
      [`${bp}.pos.y`, body.pos.y, '初始高度 y'],
      [`${bp}.vel.x`, body.vel.x, '水平初速度'],
      [`${bp}.vel.y`, body.vel.y, '竖直初速度（平抛填 0）'],
    ] as const) {
      if (value === null) blockers.push(missing(path, `缺少${label}`));
    }
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['insufficient'] };

    const g = scene.gravity!;
    const x0 = body.pos.x!;
    const y0 = body.pos.y!;
    const vx = body.vel.x!;
    const vy = body.vel.y!;
    if (y0 < 0) blockers.push(issue('constraint_conflict', `${bp}.pos.y`, '初始位置在地面（y=0）以下'));
    if (y0 === 0 && vy < 0) blockers.push(issue('constraint_conflict', `${bp}.vel.y`, '在地面以向下初速度抛出，会立即穿入地面'));
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['conflict'] };

    const unsupported = scene.asks.filter((a) => ['rest', 'end_of_support', 'friction_state'].includes(a.kind));
    for (const a of unsupported) {
      blockers.push(issue('unsupported_combo', `asks.${a.id}`, '抛体模板不支持该待求量（rest/end_of_support/friction_state）'));
    }
    if (blockers.length) return { ok: false, report: { blockers, pending }, flags: ['out_of_scope'] };

    const disc = vy * vy + 2 * g * y0;
    const canLand = y0 > 0 || vy > 0;
    const tGround = canLand && disc >= 0 ? (vy + Math.sqrt(disc)) / g : null;
    const tApex = vy > 0 ? vy / g : null;

    // 抛体与斜面联动：求抛物线与场景内各斜面段的首个交点（取段内最小正根）
    let tHit: number | null = null;
    let hitSup: Support | null = null;
    let hitPoint: { x: number; y: number } | null = null;
    for (const sup of scene.supports) {
      if (sup.angleDeg === null || sup.length === null || (sup.angleDeg === 0 && sup.a.y === 0)) continue;
      const d = supportDir(sup);
      if (Math.abs(d.x) < EPS) continue;
      const tan = d.y / d.x;
      const ax = sup.a.x;
      const ay = sup.a.y;
      const roots = positiveRoots(quadraticRoots(0.5 * g, tan * vx - vy, ay - y0 + tan * (x0 - ax)), tGround ?? Infinity);
      for (const t of roots) {
        const x = x0 + vx * t;
        const y = y0 + vy * t - 0.5 * g * t * t;
        const along = (x - ax) * d.x + (y - ay) * d.y;
        if (along < -1e-7 || along > supportLength(sup) + 1e-7) continue;
        if (tHit === null || t < tHit) {
          tHit = t;
          hitSup = sup;
          hitPoint = { x, y };
        }
        break;
      }
    }
    const tLand = tHit !== null ? null : tGround;
    const maxAskTime = Math.max(0, ...scene.asks.map((a) => a.t ?? 0));
    const tEnd = tHit ?? tGround ?? Math.max(3, tApex ? 2 * tApex : 0, maxAskTime);

    const evalAt = (time: number): Sample => {
      const t = Math.min(Math.max(time, 0), tEnd);
      const x = x0 + vx * t;
      let y = y0 + vy * t - 0.5 * g * t * t;
      if (tGround !== null && Math.abs(t - tGround) < EPS) y = 0;
      return { t, x, y, vx, vy: vy - g * t, s: x - x0 };
    };
    const times = Array.from({ length: 401 }, (_, i) => (tEnd * i) / 400);
    if (tHit !== null) times.push(tHit);
    else if (tGround !== null) times.push(tGround);
    if (tApex !== null) times.push(Math.min(tApex, tEnd));
    const samples = dedupeNumbers(times).map(evalAt);

    const answers: Answer[] = [];
    const steps: DerivationStep[] = [
      {
        title: '运动分解',
        formula: 'x=x_0+v_x t,\\quad y=y_0+v_y t-\\frac{1}{2}g t^2,\\quad v_y=v_{y0}-g t',
        substitution: `x_0=${latexNum(x0)},\\ y_0=${latexNum(y0)},\\ v_x=${latexNum(vx)},\\ v_{y0}=${latexNum(vy)},\\ g=${latexNum(g)}`,
        note: '水平方向匀速、竖直方向匀变速，两方向共用同一时间 t。',
      },
    ];
    const formulas = [
      { label: '水平位移', latex: 'x=x_0+v_x t' },
      { label: '竖直位移', latex: 'y=y_0+v_y t-\\frac{1}{2}g t^2' },
      { label: '竖直速度', latex: 'v_y=v_{y0}-g t' },
    ];

    if (tLand !== null && tLand > EPS) {
      const land = evalAt(tLand);
      const range = land.x - x0;
      answers.push(
        { id: 'land_t', label: '落地时间', value: tLand, unit: 's' },
        { id: 'land_range', label: '水平射程', value: range, unit: 'm' },
        { id: 'land_v', label: '落地速度大小', value: Math.hypot(land.vx, land.vy), unit: 'm/s', note: `水平分量 ${fmt(land.vx)} m/s，竖直分量 ${fmt(land.vy)} m/s` },
      );
      steps.push(
        {
          title: '落地时间（取正根）',
          formula: 'y_0+v_y t-\\frac{1}{2}g t^2=0 \\Rightarrow t=\\frac{v_y+\\sqrt{v_y^2+2 g y_0}}{g}',
          substitution: `t=\\frac{${latexNum(vy)}+\\sqrt{${latexNum(vy)}^2+2\\times ${latexNum(g)}\\times ${latexNum(y0)}}}{${latexNum(g)}}=${latexNum(tLand)}\\ \\mathrm{s}`,
        },
        {
          title: '水平射程与落地速度',
          formula: 'R=v_x t,\\quad v=\\sqrt{v_x^2+(v_y-g t)^2}',
          substitution: `R=${latexNum(vx)}\\times ${latexNum(tLand)}=${latexNum(range)}\\ \\mathrm{m}`,
        },
      );
      formulas.push({ label: '落地时间', latex: 't=\\frac{v_y+\\sqrt{v_y^2+2 g y_0}}{g}' });
    }

    if (tHit !== null && hitPoint && hitSup) {
      const hitVy = vy - g * tHit;
      answers.push(
        { id: 'hit_t', label: `落到「${hitSup.name}」的时间`, value: tHit, unit: 's' },
        { id: 'hit_x', label: '落点 x', value: hitPoint.x, unit: 'm' },
        { id: 'hit_y', label: '落点 y', value: hitPoint.y, unit: 'm' },
        { id: 'hit_v', label: '落到斜面时速度大小', value: Math.hypot(vx, hitVy), unit: 'm/s', note: `水平分量 ${fmt(vx)} m/s，竖直分量 ${fmt(hitVy)} m/s` },
      );
      steps.push({
        title: '落到斜面（抛物线与斜面直线求交）',
        formula: 'y_0+v_y t-\\tfrac{1}{2}g t^2=y_a+\\tan\\theta\\,(x_0+v_x t-x_a)',
        substitution: `\\tfrac{1}{2}g t^2+(\\tan\\theta\\,v_x-v_y)t+(y_a-y_0+\\tan\\theta(x_0-x_a))=0 \\Rightarrow t=${latexNum(tHit)}\\ \\mathrm{s}`,
        note: `斜面倾角 θ=${fmt(hitSup.angleDeg!)}°；取落在斜面段内的最小正根，落到斜面后运动结束。`,
      });
      formulas.push({ label: '落斜面时间', latex: 'y_0+v_y t-\\tfrac{1}{2}g t^2=y_a+\\tan\\theta(x_0+v_x t-x_a)' });
    }

    if (tApex !== null && tApex <= tEnd + EPS) {
      const hMax = y0 + (vy * vy) / (2 * g);
      answers.push(
        { id: 'apex_t', label: '到达最高点时间', value: tApex, unit: 's' },
        { id: 'apex_h', label: '最高点高度', value: hMax, unit: 'm', note: `相对抛出点上升 ${fmt((vy * vy) / (2 * g))} m` },
      );
      steps.push({
        title: '最高点（竖直分速度为零）',
        formula: 't=\\frac{v_y}{g},\\quad H=y_0+\\frac{v_y^2}{2g}',
        substitution: `t=\\frac{${latexNum(vy)}}{${latexNum(g)}}=${latexNum(tApex)}\\ \\mathrm{s},\\quad H=${latexNum(y0)}+\\frac{${latexNum(vy)}^2}{2\\times ${latexNum(g)}}=${latexNum(hMax)}\\ \\mathrm{m}`,
      });
    }

    const flags = new Set<'multi'>();
    for (const ask of scene.asks) {
      if (ask.kind === 'at_time') {
        const t = ask.t!;
        if (t > tEnd + EPS) {
          answers.push({ id: ask.id, label: `t=${fmt(t)} s 时的状态`, value: null, unit: '', note: '该时刻在运动结束之后' });
          continue;
        }
        const st = evalAt(t);
        answers.push(
          { id: `${ask.id}.x`, label: `t=${fmt(t)} s：位置 x`, value: st.x, unit: 'm' },
          { id: `${ask.id}.y`, label: `t=${fmt(t)} s：高度 y`, value: st.y, unit: 'm' },
          { id: `${ask.id}.vy`, label: `t=${fmt(t)} s：竖直速度`, value: st.vy, unit: 'm/s' },
          { id: `${ask.id}.v`, label: `t=${fmt(t)} s：速度大小`, value: Math.hypot(st.vx, st.vy), unit: 'm/s' },
        );
        steps.push({
          title: `t=${fmt(t)} s 的状态`,
          formula: 'x=x_0+v_x t,\\ y=y_0+v_y t-\\frac{1}{2}g t^2,\\ v_y=v_{y0}-g t',
          substitution: `x=${latexNum(st.x)}\\ \\mathrm{m},\\ y=${latexNum(st.y)}\\ \\mathrm{m},\\ v_y=${latexNum(st.vy)}\\ \\mathrm{m/s}`,
        });
      }
      if (ask.kind === 'at_height') {
        const Y = ask.y!;
        const roots = positiveRoots(quadraticRoots(-0.5 * g, vy, y0 - Y), tEnd);
        if (roots.length === 0) {
          answers.push({ id: ask.id, label: `经过 y=${fmt(Y)} m 的时刻`, value: null, unit: 's', note: '轨迹不经过该高度（或已落地）' });
        } else {
          if (roots.length > 1) flags.add('multi');
          answers.push({
            id: ask.id, label: `经过 y=${fmt(Y)} m 的时刻`, value: roots[0], unit: 's',
            others: roots.slice(1).map((r) => ({ value: r, unit: 's' })),
            note: roots.length > 1 ? '上升段与下降段各经过一次，属于多解' : undefined,
          });
          steps.push({
            title: `经过高度 ${fmt(Y)} m`,
            formula: 'y_0+v_y t-\\frac{1}{2}g t^2=Y',
            substitution: `${latexNum(y0)}+${latexNum(vy)} t-${latexNum(0.5 * g)} t^2=${latexNum(Y)} \\Rightarrow t=${roots.map((r) => latexNum(r)).join(',\\ ')}\\ \\mathrm{s}`,
          });
        }
      }
      if (ask.kind === 'at_position') {
        const X = ask.x!;
        if (Math.abs(vx) < EPS) {
          answers.push({ id: ask.id, label: `到达 x=${fmt(X)} m 的时刻`, value: null, unit: 's', note: '水平速度为 0，水平位置不变' });
        } else {
          const t = (X - x0) / vx;
          const valid = t > EPS && t <= tEnd + EPS;
          answers.push({ id: ask.id, label: `到达 x=${fmt(X)} m 的时刻`, value: valid ? t : null, unit: 's', note: valid ? undefined : '该位置不在运动时间范围内' });
        }
      }
    }

    return {
      ok: true,
      solution: withEnergy(scene, {
        template: 'projectile', sceneRev: scene.rev, tEnd,
        stages: [{ label: '自由飞行', t0: 0, t1: tEnd }],
        answers, steps, formulas, samples,
        flags: [...flags],
        evalAt,
        events: [
          ...(tApex !== null && tApex <= tEnd ? [{ kind: 'apex', t: tApex, label: '最高点' }] : []),
          ...(tHit !== null ? [{ kind: 'hit_support', t: tHit, label: '落到斜面' }] : []),
          ...(tLand !== null ? [{ kind: 'landing', t: tLand, label: '落地' }] : []),
        ],
      }),
    };
  },
};
