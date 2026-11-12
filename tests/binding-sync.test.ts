import { describe, expect, it } from 'vitest';
import { inclineExample } from '../src/model/factory';
import { getAt } from '../src/model/paths';
import { withField } from '../src/state/editing';

describe('参数绑定与画布几何同步', () => {
  it('编辑绑定字段时同时更新命名参数和原始字段', () => {
    const scene = inclineExample();
    const sup = scene.supports[0];
    const next = withField(scene, `supports.${sup.id}.angleDeg`, 45);
    expect(next.params.find((p) => p.name === 'theta')?.value).toBe(45);
    expect(getAt(next, `supports.${sup.id}.angleDeg`)).toBe(45);
    expect(next.rev).toBe(scene.rev + 1);
  });

  it('编辑命名参数时同步所有绑定字段，画布与求解使用同一几何', () => {
    const scene = inclineExample();
    const sup = scene.supports[0];
    const next = withField(scene, 'params.theta.value', 50);
    expect(getAt(next, `supports.${sup.id}.angleDeg`)).toBe(50);
    expect(next.rev).toBe(scene.rev + 1);
  });
});
