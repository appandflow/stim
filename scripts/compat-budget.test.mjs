import { describe, expect, it } from 'vitest';
import { budgetProblems, markedLines } from './compat-budget.mjs';

const rows = { C10: { loc: 2, end: 'permanent' } };

describe('compat budget', () => {
  it('counts the non-blank lines inside a known row within its budget', () => {
    const text = 'a();\n// compat C10 permanent\nif (v !== 2) refuse();\n\nupdate();\n// compat end\nb();';
    const { counts, problems } = markedLines('pairing.ts', text);
    expect(counts).toEqual({ C10: 2 });
    expect([...problems, ...budgetProblems(counts, rows)]).toEqual([]);
  });

  it('fails an unknown row, a row over its budget and a block left open', () => {
    const over = markedLines('a.ts', '// compat C10 permanent\na();\nb();\nc();\n// compat end');
    const unknown = markedLines('b.ts', '// compat C99 until 1.50.0\na();\n// compat end');
    const open = markedLines('c.ts', '// compat C10 permanent\na();');
    expect(budgetProblems({ ...over.counts, ...unknown.counts }, rows)).toEqual([
      'C10 marks 3 lines, over its budget of 2.',
      'C99 is not a row of scripts/compat-budget.json.',
    ]);
    expect(open.problems).toEqual(['c.ts leaves the C10 block open.']);
  });
});
