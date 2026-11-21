import type { Num, Scene } from '../model/types';
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
  return withFields(scene, [[path, value]]);
}

export function withFields(scene: Scene, updates: [string, unknown][]): Scene {
  let next = updates.reduce((candidate, [path, value]) => setAt(candidate, path, value), scene);
  const proposals = new Map<string, Num>();
  const paramNames = new Set(next.params.map((p) => p.name));
  const includes = (fieldPath: string) => updates.some(([path]) => fieldPath === path || fieldPath.startsWith(`${path}.`));

  // 未变化分量也参与提议；先检测共享参数冲突，再广播以避免顺序依赖。
  for (const [fieldPath, paramName] of Object.entries(scene.bindings)) {
    if (!includes(fieldPath) || !paramNames.has(paramName)) continue;
    const proposed = getAt(next, fieldPath);
    if (typeof proposed !== 'number' && proposed !== null) continue;
    if (proposals.has(paramName) && proposals.get(paramName) !== proposed) return scene;
    proposals.set(paramName, proposed);
  }
  for (const param of next.params) {
    if (includes(`params.${param.name}.value`)) proposals.set(param.name, param.value);
  }

  if (updates.some(([path]) => path === 'params')) {
    for (const [fieldPath, paramName] of Object.entries(scene.bindings)) {
      if (paramNames.has(paramName)) continue;
      // Removing a parameter is an unbind, not a loss of its last effective value.
      next = setAt(next, fieldPath, fieldValue(scene, fieldPath));
      delete next.bindings[fieldPath];
    }
  }
  next = { ...next, params: next.params.map((p) => proposals.has(p.name) ? { ...p, value: proposals.get(p.name)! } : p) };
  for (const [fieldPath, paramName] of Object.entries(next.bindings)) {
    if (proposals.has(paramName)) next = setAt(next, fieldPath, proposals.get(paramName));
  }
  next.rev = scene.rev + 1;
  return next;
}

export function withBinding(scene: Scene, path: string, paramName: string): Scene {
  const bindings = { ...scene.bindings };
  if (paramName) bindings[path] = paramName;
  else delete bindings[path];
  const value = paramName ? scene.params.find((p) => p.name === paramName)?.value ?? null : fieldValue(scene, path);
  return { ...setAt(scene, path, value), bindings };
}

export function newParamName(scene: Scene): string {
  let i = scene.params.length + 1;
  while (scene.params.some((p) => p.name === `p${i}`)) i++;
  return `p${i}`;
}
