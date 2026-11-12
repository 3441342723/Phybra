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
