import type { Scene } from '../model/types';
import { getAt, setAt } from '../model/paths';

export type FieldEdit = {
  commit: (path: string, value: unknown) => void;
  transient: (path: string, value: unknown) => void;
};

export function fieldValue(scene: Scene, path: string): any {
  const bound = scene.bindings[path];
  if (bound) return scene.params.find((p) => p.name === bound)?.value ?? null;
  return getAt(scene, path);
}

export function withField(scene: Scene, path: string, value: unknown): Scene {
  const bound = scene.bindings[path];
  if (bound) {
    return { ...scene, rev: scene.rev + 1, params: scene.params.map((p) => (p.name === bound ? { ...p, value: value as number | null } : p)) };
  }
  return setAt(scene, path, value);
}

export function withBinding(scene: Scene, path: string, paramName: string): Scene {
  const bindings = { ...scene.bindings };
  if (paramName) bindings[path] = paramName;
  else delete bindings[path];
  return { ...scene, rev: scene.rev + 1, bindings };
}

export function newParamName(scene: Scene): string {
  let i = scene.params.length + 1;
  while (scene.params.some((p) => p.name === `p${i}`)) i++;
  return `p${i}`;
}
