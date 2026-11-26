import type { EnergyEvent, EnergyPoint } from './types';

export const ENERGY_EVENTS: ReadonlyArray<{ id: EnergyEvent; label: string }> = [
  { id: 'initial', label: '初始时刻' },
  { id: 'apex', label: '最高点' },
  { id: 'landing', label: '落地' },
  { id: 'end_of_support', label: '轨道外端点' },
  { id: 'final_rest', label: '最终静止' },
  { id: 'field_exit', label: '首次出场' },
  { id: 'collision', label: '碰撞后瞬间' },
];

export function isEnergyPoint(value: unknown): value is EnergyPoint {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Partial<EnergyPoint>;
  return (point.kind === 'time' && (point.t === null || typeof point.t === 'number'))
    || (point.kind === 'event' && ENERGY_EVENTS.some(({ id }) => id === point.event));
}
