import type { UnitKind } from './types';

type UnitDef = { si: number; label: string };

export const UNITS: Record<UnitKind, Record<string, UnitDef>> = {
  length: { m: { si: 1, label: 'm' }, cm: { si: 0.01, label: 'cm' }, mm: { si: 0.001, label: 'mm' }, km: { si: 1000, label: 'km' } },
  time: { s: { si: 1, label: 's' }, ms: { si: 0.001, label: 'ms' }, min: { si: 60, label: 'min' } },
  speed: { 'm/s': { si: 1, label: 'm/s' }, 'km/h': { si: 1000 / 3600, label: 'km/h' }, 'cm/s': { si: 0.01, label: 'cm/s' } },
  accel: { 'm/s²': { si: 1, label: 'm/s²' }, 'cm/s²': { si: 0.01, label: 'cm/s²' } },
  mass: { kg: { si: 1, label: 'kg' }, g: { si: 0.001, label: 'g' }, t: { si: 1000, label: 't' } },
  angle: { '°': { si: 1, label: '°' }, rad: { si: 180 / Math.PI, label: 'rad' } },
  none: { '': { si: 1, label: '' } },
};

export function toSI(value: number, unit: string, kind: UnitKind): number | null {
  const def = UNITS[kind][unit];
  return def ? value * def.si : null;
}

export function fromSI(value: number, unit: string, kind: UnitKind): number | null {
  const def = UNITS[kind][unit];
  return def ? value / def.si : null;
}

export function defaultUnit(kind: UnitKind): string {
  return Object.keys(UNITS[kind])[0];
}

/** 输出统一 3 位有效数字，去掉浮点噪声 */
export function fmt(value: number | null, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e5 || abs < 1e-3) return value.toExponential(2);
  const rounded = Number(value.toPrecision(digits));
  return String(rounded);
}

export function fmtWith(value: number | null, unit: string): string {
  if (value === null) return '—';
  return `${fmt(value)} ${unit}`.trim();
}
