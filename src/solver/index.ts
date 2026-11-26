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
