import { describe, expect, it } from 'vitest';
import { inclineExample, projectileExample } from '../src/model/factory';
import { parseScene, parseSceneDraft } from '../src/model/runtime';
import { demoDraft } from '../src/ai/demo';

describe('runtime scene validation', () => {
  it('accepts factory scenes and preserves nullable physical values', () => {
    const scene = inclineExample();
    const parsed = parseScene(JSON.parse(JSON.stringify(scene)));
    expect(parsed.bindings).toEqual(scene.bindings);
    expect(parsed.contacts[0].mu_k).toBe(0.3);
    expect(parseScene(projectileExample()).bodies[0].mass).toBeNull();
  });

  it('rejects duplicate IDs and dangling references', () => {
    const scene = inclineExample();
    const duplicate = structuredClone(scene);
    duplicate.bodies.push(structuredClone(duplicate.bodies[0]));
    expect(() => parseScene(duplicate)).toThrow(/重复 id/);

    const dangling = structuredClone(scene);
    dangling.contacts[0].support = 'missing-support';
    expect(() => parseScene(dangling)).toThrow(/引用不存在/);
  });

  it('rejects malformed bindings and non-finite numbers', () => {
    const scene = inclineExample();
    const badBinding = structuredClone(scene);
    badBinding.bindings['supports.missing.length'] = 'theta';
    expect(() => parseScene(badBinding)).toThrow(/不是可绑定的数值字段/);

    const badNumber = structuredClone(scene);
    badNumber.gravity = Number.NaN;
    expect(() => parseScene(badNumber)).toThrow(/有限数字/);
  });

  it('validates the complete AI draft contract', () => {
    const scene = projectileExample();
    const draft = parseSceneDraft({
      source: { rawText: '题目' },
      scene,
      known: [{ path: 'gravity', label: '重力', value: '9.8 m/s²', quote: '题干' }],
      assumed: [],
      unknown: [{ path: `asks.${scene.asks[0].id}.t`, label: '时间' }],
      uncertain: [],
      warnings: [],
    });
    expect(draft.scene.title).toBe(scene.title);
    expect(() => parseSceneDraft({ ...draft, warnings: ['ok', 3] })).toThrow(/必须是字符串/);
    expect(() => parseSceneDraft({ ...draft, known: undefined })).toThrow(/必须是数组/);
  });

  it('accepts both built-in demo drafts through the same boundary parser', () => {
    expect(parseSceneDraft(demoDraft('flat', '平抛')).source.demo).toBe(true);
    expect(parseSceneDraft(demoDraft('incline', '斜面')).unknown.length).toBeGreaterThan(0);
    expect(parseSceneDraft(demoDraft('plates', '平行板电场')).scene.fields?.[0].plates?.voltage).toBe(12);
    expect(parseSceneDraft(demoDraft('plates', '平行板电场')).scene.bodies[0].charge).toBe(1);
    const incomplete = demoDraft('plates', '平行板电场');
    incomplete.scene.fields![0].plates!.voltage = null;
    incomplete.scene.fields![0].vector = { x: null, y: null } as any;
    incomplete.unknown.push({ path: `fields.${incomplete.scene.fields![0].id}.plates.voltage`, label: '板间电压' });
    // 缺少板间电压时，当前契约将平行板退化为普通矢量匀强场，避免求解器误用不完整的 plates 配置。
    expect(parseSceneDraft(incomplete).scene.fields?.[0].plates).toBeUndefined();
  });
});
