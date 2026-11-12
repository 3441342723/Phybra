import type { CheckIssue, Scene, SolveResult } from '../model/types';

export type Template = {
  id: 'kinematics-1d' | 'projectile' | 'incline-friction';
  match: (scene: Scene) => boolean;
  solve: (scene: Scene) => SolveResult;
};

export function issue(code: CheckIssue['code'], path: string, message: string): CheckIssue {
  return { code, path, message };
}

export function missing(path: string, message: string): CheckIssue {
  return issue('missing_required', path, message);
}
