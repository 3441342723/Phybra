import type { Scene, SolveResult } from '../model/types';
import { resolveBindings } from '../model/paths';
import { validateScene } from '../model/validate';
import { circularTemplate } from './circular';
import { compositionTemplate } from './composition';
import { inclineTemplate } from './incline';
import { kinematicsTemplate } from './kinematics1d';
import { multiTrackTemplate } from './multiTrack';
import { projectileTemplate } from './projectile';
import type { Template } from './template';
import { reportUnsupportedEnergyQueries } from './energy';
import { fieldTemplate } from './fields';
import { collisionTemplate } from './collision';
import { spatialTemplate } from './spatial';

/** 不同对象组合的求解模板。 */
export const TEMPLATES: Template[] = [spatialTemplate, collisionTemplate, fieldTemplate, compositionTemplate, circularTemplate, multiTrackTemplate, inclineTemplate, kinematicsTemplate, projectileTemplate];

export function classify(scene: Scene): Template | null {
  return TEMPLATES.find((t) => t.match(scene)) ?? null;
}

export function solve(input: Scene): SolveResult {
  const scene = resolveBindings(input);
  const structural = validateScene(scene);
  if (structural.blockers.length) return { ok: false, report: structural, flags: ['insufficient'] };
  const template = classify(scene);
  if (!template) {
    return {
      ok: false,
      flags: ['out_of_scope'],
      report: {
        blockers: [{ code: 'unsupported_combo', path: 'bodies', message: '当前组合不在支持范围。电磁场请搭配一个小球，其他题型可从顶部示例载入。' }],
        pending: structural.pending,
      },
    };
  }
  const result = template.solve(scene);
  if (result.ok) {
    result.solution.sceneRev = input.rev;
    const customOnly = scene.asks.length > 0 && scene.asks.every((ask) => ask.kind === 'custom');
    const unsupportedSpring = customOnly && scene.params.some((param) => param.unit === 'stiffness');
    for(const ask of scene.asks.filter(a=>a.kind==='custom')) {
      const answer=result.solution.answers.find(a=>a.id===ask.id);
      const question=ask.question??'';
      const fieldEntryQuery = /(?:进场|进入(?:电|磁)?场|进入场区|场区入口|入口)/.test(question);
      const fieldExitQuery = /(?:出场|离场|离开(?:电|磁)?场|穿出(?:电|磁)?场|离开场区|穿出场区|场区出口|出口)/.test(question);
      const genericFieldBoundaryQuery = /场区(?:进出|边界)/.test(question);
      const fieldAfterQuery = /(?:出场后|进场后|离开(?:电|磁)?场后|进入(?:电|磁)?场后|离开场区后|之后|以后|随后|继续|最高点|落地后)/.test(question);
      const hasFieldEntry=scene.asks.some(a=>a.kind==='field_entry');
      const hasFieldExit=scene.asks.some(a=>a.kind==='field_exit');
      const fieldQueryCovered=(fieldEntryQuery&&hasFieldEntry)
        ||(fieldExitQuery&&hasFieldExit)
        ||(genericFieldBoundaryQuery&&(hasFieldEntry||hasFieldExit));
      const duplicatesFieldQuery=fieldQueryCovered
        && !fieldAfterQuery
        && /(?:时间|时刻|位置|位移|速度|速率|方向|坐标)/.test(question);
      const note=duplicatesFieldQuery
        ? '该问题已由场区进出场结果覆盖，请查看对应进场/出场待求量的时间、位置、位移和速度字段。'
        : '此问题已保留，当前没有对应的专用求解；请查看相关阶段或补充建模。';
      if(answer){answer.label=ask.question??'题目待求';answer.value=null;answer.note=note;}
      else result.solution.answers.push({id:ask.id,label:ask.question??'题目待求',value:null,unit:'',note});
    }
    if (unsupportedSpring) {
      const customIds = new Set(scene.asks.map((ask) => ask.id));
      result.solution.answers = result.solution.answers.filter((answer) => customIds.has(answer.id));
      result.solution.steps = [];
      result.solution.formulas = [];
      result.solution.notice = '当前题目包含弹簧模型，但工作台暂不支持弹簧动力学；仅保留原待求问题，不输出等效普通运动结果。';
    }
    if (!result.solution.energy) reportUnsupportedEnergyQueries(scene, result.solution);
    if (scene.bodies[0].kind !== 'ball') {
      for (const ask of scene.asks.filter(a => a.kind === 'field_exit'||a.kind === 'field_entry')) {
        result.solution.answers.push({ id: ask.id, label: ask.kind === 'field_entry' ? '首次进场' : '首次出场', value: null, unit: 's', note: '请在场运动场景中使用此待求量。' });
      }
    }
  }
  else result.report.pending = [...structural.pending, ...result.report.pending];
  return result;
}

export function checkPending(scene: Scene) {
  return validateScene(resolveBindings(scene)).pending;
}
