import { describe, expect, it } from 'vitest';
import { inclineExample } from '../src/model/factory';
import { describePath, getAt, setAt } from '../src/model/paths';

describe('路径寻址（校验报告 → 编辑器选中）', () => {
  it('不带属性的集合路径也能生成可读标签（回归：白屏）', () => {
    const sc = inclineExample();
    expect(describePath(sc, 'bodies')).toBe('物体');
    expect(describePath(sc, 'supports')).toBe('支撑面');
    expect(describePath(sc, 'bodies')).not.toContain('undefined');
  });

  it('接触、参数、重力均有可读标签', () => {
    const sc = inclineExample();
    const contactId = sc.contacts[0].id;
    expect(describePath(sc, `contacts.${contactId}.mu_k`)).toContain('动摩擦因数');
    expect(describePath(sc, 'gravity')).toBe('重力加速度 g');
    expect(describePath(sc, 'params.theta.value')).toContain('theta');
  });

  it('getAt/setAt 支持嵌套与集合 id 寻址', () => {
    const sc = inclineExample();
    const blockId = sc.bodies[0].id;
    expect(getAt(sc, `bodies.${blockId}.attach.s`)).toBe(5);
    const next = setAt(sc, `bodies.${blockId}.attach.s`, 3);
    expect(getAt(next, `bodies.${blockId}.attach.s`)).toBe(3);
    expect(next.rev).toBe(sc.rev + 1);
    expect(getAt(sc, `bodies.${blockId}.attach.s`)).toBe(5);
  });
});
