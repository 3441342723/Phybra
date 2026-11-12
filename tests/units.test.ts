import { describe, expect, it } from 'vitest';
import { defaultUnit, fmt, fromSI, toSI } from '../src/model/units';

describe('单位换算（SI 内部表示）', () => {
  it('速度：km/h 与 cm/s', () => {
    expect(toSI(36, 'km/h', 'speed')).toBeCloseTo(10, 12);
    expect(toSI(500, 'cm/s', 'speed')).toBeCloseTo(5, 12);
    expect(fromSI(10, 'km/h', 'speed')).toBeCloseTo(36, 12);
  });
  it('长度：cm/mm/km', () => {
    expect(toSI(500, 'cm', 'length')).toBe(5);
    expect(toSI(2500, 'mm', 'length')).toBe(2.5);
    expect(toSI(1.2, 'km', 'length')).toBe(1200);
  });
  it('质量与时间', () => {
    expect(toSI(500, 'g', 'mass')).toBe(0.5);
    expect(toSI(2, 'min', 'time')).toBe(120);
    expect(toSI(30, 'ms', 'time')).toBeCloseTo(0.03, 12);
  });
  it('角度：rad → °', () => {
    expect(toSI(Math.PI / 6, 'rad', 'angle')).toBeCloseTo(30, 12);
  });
  it('未知单位返回 null，不猜测', () => {
    expect(toSI(1, 'mile', 'length')).toBeNull();
  });
  it('有效数字格式化', () => {
    expect(fmt(2.061390533)).toBe('2.06');
    expect(fmt(0)).toBe('0');
    expect(fmt(null)).toBe('—');
    expect(defaultUnit('speed')).toBe('m/s');
  });
});
