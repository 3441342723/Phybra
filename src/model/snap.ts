import type { Vec2 } from './types';

export type SnapSettings = { enabled: boolean; step: number };

export function snapValue(value: number, settings: SnapSettings): number {
  if (!settings.enabled || !Number.isFinite(settings.step) || settings.step <= 0) return value;
  return Number((Math.round(value / settings.step) * settings.step).toFixed(9));
}

export function snapPoint(point: Vec2, settings: SnapSettings): Vec2 {
  return { x: snapValue(point.x, settings), y: snapValue(point.y, settings) };
}
