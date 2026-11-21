import type { Vec2 } from '../model/types';
import type { Camera } from './store';

export type WindowId = 'objects' | 'properties' | 'result' | 'charts' | 'ai';
export type WindowRect = { x: number; y: number; w: number; h: number };
export type WindowLayout = {
  rects: Record<WindowId, WindowRect>;
  open: Record<WindowId, boolean>;
  z: Record<WindowId, number>;
};

export const WINDOW_IDS: WindowId[] = ['objects', 'properties', 'result', 'charts', 'ai'];
const LAYOUT_KEY = 'phy.windows.v1';

export function defaultLayout(width = 1280, height = 720): WindowLayout {
  const w = Math.max(360, width);
  const h = Math.max(360, height);
  const sideWidth = Math.min(280, w * 0.32);
  return {
    rects: {
      objects: { x: 12, y: 12, w: sideWidth, h: Math.min(440, h - 24) },
      properties: { x: w - sideWidth - 12, y: 12, w: sideWidth, h: Math.min(310, h - 24) },
      result: { x: sideWidth + 24, y: h - 238, w: Math.max(320, w - sideWidth * 2 - 48), h: 226 },
      charts: { x: w - Math.min(430, w * 0.45) - 12, y: Math.min(334, h - 270), w: Math.min(430, w * 0.45), h: 258 },
      ai: { x: Math.max(12, (w - Math.min(680, w - 24)) / 2), y: 24, w: Math.min(680, w - 24), h: Math.min(590, h - 48) },
    },
    open: { objects: true, properties: true, result: true, charts: true, ai: false },
    z: { objects: 1, properties: 2, result: 3, charts: 4, ai: 5 },
  };
}

export function clampRect(rect: WindowRect, width: number, height: number): WindowRect {
  const w = Math.min(Math.max(240, rect.w), Math.max(240, width));
  const h = Math.min(Math.max(160, rect.h), Math.max(160, height));
  return {
    x: Math.max(0, Math.min(rect.x, Math.max(0, width - w))),
    y: Math.max(0, Math.min(rect.y, Math.max(0, height - h))),
    w,
    h,
  };
}

export function fitPlaybackCamera(camera: Camera, points: Vec2[], layout: WindowLayout, width: number, height: number): Camera {
  if (!points.length || width <= 64 || height <= 64) return camera;
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const panels = WINDOW_IDS.filter((id) => layout.open[id]).map((id) => layout.rects[id]);
  const intersects = (left: number, top: number, right: number, bottom: number) => panels.some((r) =>
    left < r.x + r.w && right > r.x && top < r.y + r.h && bottom > r.y);
  if (points.every((p, i) => {
    const previous = points[Math.max(0, i - 1)];
    const left = camera.ox + Math.min(p.x, previous.x) * camera.scale - 32;
    const right = camera.ox + Math.max(p.x, previous.x) * camera.scale + 32;
    const top = camera.oy - Math.max(p.y, previous.y) * camera.scale - 32;
    const bottom = camera.oy - Math.min(p.y, previous.y) * camera.scale + 32;
    return left >= -1e-7 && right <= width + 1e-7 && top >= -1e-7 && bottom <= height + 1e-7 &&
      !intersects(left + 1e-7, top + 1e-7, right - 1e-7, bottom - 1e-7);
  })) return camera;

  const xs = [...new Set([0, width, ...panels.flatMap((r) => [r.x, r.x + r.w])])]
    .filter((x) => x >= 0 && x <= width).sort((a, b) => a - b);
  const ys = [...new Set([0, height, ...panels.flatMap((r) => [r.y, r.y + r.h])])]
    .filter((y) => y >= 0 && y <= height).sort((a, b) => a - b);
  let best = camera;
  let bestScale = 0;
  let bestArea = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      for (let k = 0; k < ys.length - 1; k++) {
        for (let l = k + 1; l < ys.length; l++) {
          const w = xs[j] - xs[i];
          const h = ys[l] - ys[k];
          if (w <= 64 || h <= 64 || intersects(xs[i], ys[k], xs[j], ys[l])) continue;
          const scale = Math.min(camera.scale, (w - 64) / Math.max(maxX - minX, 1), (h - 64) / Math.max(maxY - minY, 1));
          if (scale < bestScale || (scale === bestScale && w * h <= bestArea)) continue;
          bestScale = scale;
          bestArea = w * h;
          best = {
            scale,
            ox: (xs[i] + xs[j]) / 2 - (minX + maxX) * scale / 2,
            oy: (ys[k] + ys[l]) / 2 + (minY + maxY) * scale / 2,
          };
        }
      }
    }
  }
  return best;
}

export function loadLayout(): WindowLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as WindowLayout;
    if (!value?.rects || !value?.open || !value?.z) return null;
    if (!WINDOW_IDS.every((id) => {
      const r = value.rects[id];
      return r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && typeof value.open[id] === 'boolean' && Number.isFinite(value.z[id]);
    })) return null;
    return value;
  } catch {
    return null;
  }
}

export function saveLayout(layout: WindowLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* 窗口布局丢失不影响场景 */
  }
}
