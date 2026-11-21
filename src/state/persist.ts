import type { Scene } from '../model/types';
import { isPlaybackRate, type Camera } from './store';
import type { SnapSettings } from '../model/snap';

const SCENE_KEY = 'phy.scene.v2';
const VIEW_KEY = 'phy.view.v1';
const SNAP_KEY = 'phy.snap.v1';
const RATE_KEY = 'phy.playbackRate.v1';

export function loadPlaybackRate(): number {
  try {
    const rate = Number(localStorage.getItem(RATE_KEY));
    return isPlaybackRate(rate) ? rate : 1;
  } catch {
    return 1;
  }
}

export function savePlaybackRate(rate: number): void {
  try { localStorage.setItem(RATE_KEY, String(rate)); } catch { /* optional preference */ }
}

export function isScene(value: unknown): value is Scene {
  const sc = value as Scene;
  return !!sc && sc.version === 2 && Array.isArray(sc.bodies) && Array.isArray(sc.supports) && Array.isArray(sc.contacts) && Array.isArray(sc.asks) && Array.isArray(sc.params) && typeof sc.bindings === 'object'
    && (sc.fields === undefined || Array.isArray(sc.fields) && sc.fields.every(f => f && typeof f.id === 'string' && f.shape && f.position && f.vector
      && (f.shape.kind !== 'polygon' || Array.isArray(f.shape.vertices)) && (f.shape.kind !== 'rect' && f.shape.kind !== 'circle' || !!f.shape.center)))
    && (sc.links === undefined || Array.isArray(sc.links) && sc.links.every(l => l && typeof l.id === 'string' && l.anchor));
}

export function loadScene(): Scene | null {
  try {
    const raw = localStorage.getItem(SCENE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isScene(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveScene(scene: Scene): void {
  try {
    localStorage.setItem(SCENE_KEY, JSON.stringify(scene));
  } catch {
    /* 存储满或被禁用时静默失败，不影响求解 */
  }
}

export function loadCamera(): Camera | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return typeof c?.scale === 'number' ? c : null;
  } catch {
    return null;
  }
}

export function saveCamera(camera: Camera): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(camera));
  } catch {
    /* 视图状态丢失不影响物理场景 */
  }
}

export function loadSnap(): SnapSettings | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return typeof value?.enabled === 'boolean' && Number.isFinite(value?.step) && value.step > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveSnap(snap: SnapSettings): void {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
  } catch {
    /* 吸附偏好丢失不影响场景 */
  }
}

export function exportScene(scene: Scene): void {
  const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${scene.title || 'scene'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function readSceneFile(file: File): Promise<Scene> {
  return file.text().then((text) => {
    const parsed = JSON.parse(text);
    if (!isScene(parsed)) throw new Error('文件不是有效的场景（需要 version=2 的 Scene JSON）');
    return parsed;
  });
}
