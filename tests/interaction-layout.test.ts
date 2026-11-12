import { describe, expect, it } from 'vitest';
import { snapPoint, snapValue } from '../src/model/snap';
import { clampRect, defaultLayout, WINDOW_IDS } from '../src/state/layout';
import { initStore, reducer } from '../src/state/store';
import { inclineExample } from '../src/model/factory';

describe('网格吸附', () => {
  it('按步长吸附坐标与沿面标量并消除浮点尾数', () => {
    expect(snapPoint({ x: 1.26, y: -0.62 }, { enabled: true, step: 0.25 })).toEqual({ x: 1.25, y: -0.5 });
    expect(snapValue(0.3, { enabled: true, step: 0.1 })).toBe(0.3);
  });

  it('关闭吸附时保留原始坐标', () => {
    expect(snapPoint({ x: 1.234, y: 5.678 }, { enabled: false, step: 0.5 })).toEqual({ x: 1.234, y: 5.678 });
  });

  it('吸附设置不改变物理场景或求解结果状态', () => {
    const before = initStore(inclineExample());
    const after = reducer(before, { type: 'snap', snap: { enabled: false, step: 0.1 } });
    expect(after.present).toBe(before.present);
    expect(after.formal).toBe(before.formal);
    expect(after.snap).toEqual({ enabled: false, step: 0.1 });
  });
});

describe('浮动窗口布局', () => {
  it('默认布局包含所有可重开的窗口', () => {
    const layout = defaultLayout(1280, 720);
    for (const id of WINDOW_IDS) {
      expect(Number.isFinite(layout.rects[id].x)).toBe(true);
      expect(typeof layout.open[id]).toBe('boolean');
    }
    expect(layout.open.ai).toBe(false);
  });

  it('移动和缩放后窗口保持在工作区范围内', () => {
    expect(clampRect({ x: -50, y: 900, w: 900, h: 700 }, 800, 600)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(clampRect({ x: 100, y: 100, w: 20, h: 20 }, 800, 600)).toEqual({ x: 100, y: 100, w: 240, h: 160 });
  });
});
