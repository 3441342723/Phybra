import { describe, expect, it } from 'vitest';
import { baseScene, makeAsk, makeBlock, makeContact, makeSupport } from '../src/model/factory';
import { nearestSupport } from '../src/model/geometry';
import { buildSurfaceTrack, trackLocalToGlobal } from '../src/model/track';
import { solve } from '../src/solver';
import { answer, close, ok } from './helpers';

describe('多支撑面选择', () => {
  it('滑块选择点击位置最近的支撑面，而不是第一个', () => {
    const first = makeSupport('incline', { x: 0, y: 0 }, 5, 30);
    const second = makeSupport('incline', { x: 10, y: 0 }, 5, 30);
    expect(nearestSupport([first, second], { x: 12, y: 1 })?.id).toBe(second.id);
    expect(nearestSupport([first, second], { x: 1, y: 0.5 })?.id).toBe(first.id);
    expect(nearestSupport([first, second], { x: 30, y: 30 }, 1.5)).toBeNull();
  });
});

describe('连续轨道', () => {
  it('水平面连接斜面：跨面速率连续，进入斜面后使用斜面加速度', () => {
    const sc = baseScene('水平接斜面');
    sc.gravity = 10;
    const flat = makeSupport('horizontal', { x: 0, y: 0 }, 5, 0);
    const ramp = makeSupport('incline', { x: 5, y: 0 }, 5, 30);
    const block = makeBlock(flat.id, 0);
    block.vel = { x: 5, y: 0 };
    sc.supports = [flat, ramp];
    sc.bodies = [block];
    sc.contacts = [makeContact(block.id, flat.id, 0.6, 0), makeContact(block.id, ramp.id, 0.6, 0)];
    sc.asks = [makeAsk('at_time', { t: 1.5 }), makeAsk('rest')];
    const sol = ok(solve(sc));
    const track = buildSurfaceTrack(sc, flat.id);
    expect(track.segments.map((s) => s.support.id)).toEqual([flat.id, ramp.id]);
    expect(trackLocalToGlobal(track, ramp.id, 0)).toBe(5);
    const junction = sol.events.find((e) => e.kind === 'junction');
    expect(junction).toBeDefined();
    close(junction!.t, 1);
    close(sol.evalAt(1).u ?? 0, 5);
    close(sol.evalAt(1.5).u ?? 0, 2.5);
    close(sol.evalAt(1.5).x, 5 + 1.875 * Math.cos(Math.PI / 6));
    close(sol.evalAt(1.5).y, 1.875 * Math.sin(Math.PI / 6));
    close(answer(sol, 'rest_t').value, 2);
  });

  it('斜面连接斜面：两段使用不同摩擦，连接点不截断运动', () => {
    const sc = baseScene('斜面接斜面');
    sc.gravity = 10;
    const down = makeSupport('incline', { x: 0, y: 5 }, 5, -30);
    const up = makeSupport('incline', { x: 5 * Math.cos(Math.PI / 6), y: 2.5 }, 5, 30);
    const block = makeBlock(down.id, 0);
    block.vel = { x: 0, y: 0 };
    sc.supports = [down, up];
    sc.bodies = [block];
    sc.contacts = [makeContact(block.id, down.id, 0, 0), makeContact(block.id, up.id, 0.6, 0.2)];
    sc.asks = [makeAsk('end_of_support')];
    const sol = ok(solve(sc));
    const junction = sol.events.find((e) => e.kind === 'junction');
    expect(junction).toBeDefined();
    close(junction!.t, Math.sqrt(2));
    close(sol.evalAt(junction!.t).u ?? 0, 5 * Math.sqrt(2));
    const u1 = sol.evalAt(junction!.t + 0.05).u ?? 0;
    const u2 = sol.evalAt(junction!.t + 0.15).u ?? 0;
    close((u2 - u1) / 0.1, -5 - 0.2 * 10 * Math.cos(Math.PI / 6));
    expect(sol.events.some((e) => e.kind === 'end_of_support')).toBe(false);
    close(answer(sol, 'rest_t').value, Math.sqrt(2) + (5 * Math.sqrt(2)) / (5 + 0.2 * 10 * Math.cos(Math.PI / 6)));
  });

  it('分叉连接被明确拒绝，不猜测路径', () => {
    const sc = baseScene('分叉');
    sc.gravity = 10;
    const flat = makeSupport('horizontal', { x: 0, y: 0 }, 5, 0);
    const up = makeSupport('incline', { x: 5, y: 0 }, 5, 30);
    const down = makeSupport('incline', { x: 5, y: 0 }, 5, -30);
    const block = makeBlock(flat.id, 0);
    block.vel = { x: 5, y: 0 };
    sc.supports = [flat, up, down];
    sc.bodies = [block];
    sc.contacts = [flat, up, down].map((s) => makeContact(block.id, s.id, 0.4, 0.3));
    const result = solve(sc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.report.blockers[0].message).toContain('分叉');
  });
});
