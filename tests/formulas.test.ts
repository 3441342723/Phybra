import katex from 'katex';
import { describe, expect, it } from 'vitest';
import { COLLISION_EXAMPLES, ELECTROMAGNETIC_EXAMPLES, EXAMPLES, SPATIAL_EXAMPLES } from '../src/model/factory';
import { solve } from '../src/solver';
import { ok } from './helpers';

describe('推导公式渲染', () => {
  for (const example of [...EXAMPLES, ...ELECTROMAGNETIC_EXAMPLES, ...COLLISION_EXAMPLES, ...SPATIAL_EXAMPLES]) {
    it(`${example.title} 的推导、代入和公式卡片均可渲染`, () => {
      const solution = ok(solve(example.build()));
      const formulas = [
        ...solution.steps.flatMap(step => [step.formula, step.substitution]),
        ...solution.formulas.map(formula => formula.latex),
      ].filter((formula): formula is string => formula !== undefined);
      expect(formulas.length).toBeGreaterThan(0);
      for (const formula of formulas) {
        // 普通字符串中的单反斜杠会将 LaTeX 命令变为换页、回车等控制字符。
        expect(formula).not.toMatch(/[\u0000-\u001f\u007f]/);
        expect(() => katex.renderToString(formula, { throwOnError: true, strict: 'ignore' })).not.toThrow();
      }
      if (solution.template === 'collision') {
        const impulse = solution.steps[1].formula!;
        expect(impulse).toContain('\\frac');
        expect(impulse).toContain('\\vec');
        const html = katex.renderToString(impulse, { throwOnError: true });
        expect(html).toContain('class="mfrac"');
        expect(html).toContain('<mover accent="true">');
      }
    });
  }
});
