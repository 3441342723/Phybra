import type { Scene, SolveResult } from '../model/types';
import { resolveBindings } from '../model/paths';
import { validateScene } from '../model/validate';
import { inclineTemplate } from './incline';
import { kinematicsTemplate } from './kinematics1d';
import { multiTrackTemplate } from './multiTrack';
import { projectileTemplate } from './projectile';
import type { Template } from './template';

/** 模块扩展点：连接体、能量与动量、电磁等后续在此注册 */
export const TEMPLATES: Template[] = [multiTrackTemplate, inclineTemplate, kinematicsTemplate, projectileTemplate];

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
        blockers: [{ code: 'unsupported_combo', path: 'bodies', message: '当前组合不在支持范围：仅支持匀变速直线、平抛/斜抛、单物体斜面与摩擦及端点相连的连续轨道' }],
        pending: structural.pending,
      },
    };
  }
  const result = template.solve(scene);
  if (result.ok) result.solution.sceneRev = input.rev;
  else result.report.pending = [...structural.pending, ...result.report.pending];
  return result;
}

export function checkPending(scene: Scene) {
  return validateScene(resolveBindings(scene)).pending;
}
