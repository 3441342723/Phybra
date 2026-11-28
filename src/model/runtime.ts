import { validateScene, validateSceneDraft } from '../../functions/draft-schema';
import type { Scene, SceneDraft } from './types';

// Share the exact contract with the self-contained Sites Function.
export function parseScene(value: unknown): Scene {
  return structuredClone(validateScene(value)) as unknown as Scene;
}

export function parseSceneDraft(value: unknown): SceneDraft {
  return structuredClone(validateSceneDraft(value)) as unknown as SceneDraft;
}
