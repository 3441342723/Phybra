import { describe, expect, it } from 'vitest';
import { snapPoint, snapValue } from '../src/model/snap';
import { clampRect, defaultLayout, fitPlaybackCamera, WINDOW_IDS } from '../src/state/layout';
import { initStore, reducer } from '../src/state/store';
import { EXAMPLES, inclineExample } from '../src/model/factory';
import { solve } from '../src/solver';
import { ok } from './helpers';

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
  it.each(EXAMPLES)('$title 播放轨迹避开已打开浮窗并留在画布内', ({ build }) => {
    const scene = build();
    const solution = ok(solve(scene));
    for (const [width, height] of [[1440, 850], [1024, 600]]) {
      const layout = defaultLayout(width, height);
      const before = initStore(scene).camera;
      const camera = fitPlaybackCamera(before, solution.samples, layout, width, height);
      for (const p of solution.samples) {
        const x = camera.ox + p.x * camera.scale;
        const y = camera.oy - p.y * camera.scale;
        expect(x).toBeGreaterThanOrEqual(32 - 1e-7);
        expect(x).toBeLessThanOrEqual(width - 32 + 1e-7);
        expect(y).toBeGreaterThanOrEqual(32 - 1e-7);
        expect(y).toBeLessThanOrEqual(height - 32 + 1e-7);
        for (const id of WINDOW_IDS.filter(id => layout.open[id])) {
          const r = layout.rects[id];
          expect(x + 24 > r.x && x - 24 < r.x + r.w && y + 24 > r.y && y - 24 < r.y + r.h, id).toBe(false);
        }
      }
      expect(fitPlaybackCamera(camera, solution.samples, layout, width, height)).toBe(camera);
    }
  });

  it('已可见轨迹不改变用户相机，静止场景也可适配', () => {
    const layout = defaultLayout(1440, 850);
    const camera = { scale: 46, ox: 600, oy: 250 };
    expect(fitPlaybackCamera(camera, [{ x: 0, y: 0 }], layout, 1440, 850)).toBe(camera);
    const fitted = fitPlaybackCamera({ scale: 46, ox: 90, oy: 380 }, [{ x: 0, y: 0 }], layout, 1440, 850);
    expect(fitted.ox).toBeGreaterThan(320);
    expect(Number.isFinite(fitted.scale)).toBe(true);
  });

  it('浮窗只占据斜向轨迹包围盒的空白区时保留相机', () => {
    const layout = defaultLayout(1440, 850);
    for (const id of WINDOW_IDS) layout.open[id] = id === 'objects';
    layout.rects.objects = { x: 600, y: 400, w: 240, h: 160 };
    const camera = { scale: 46, ox: 200, oy: 700 };
    const points = Array.from({ length: 101 }, (_, i) => ({ x: i * Math.SQRT2 / 10, y: i * Math.SQRT2 / 10 }));
    expect(fitPlaybackCamera(camera, points, layout, 1440, 850)).toBe(camera);
  });

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
