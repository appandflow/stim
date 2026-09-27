import { AGENT_PROMPTS, pickPrompts } from './agent-prompts';

describe('pickPrompts', () => {
  it('returns distinct items from the pool', () => {
    for (let run = 0; run < 50; run++) {
      const picked = pickPrompts(AGENT_PROMPTS, 3);
      expect(picked).toHaveLength(3);
      expect(new Set(picked).size).toBe(3);
      for (const prompt of picked) expect(AGENT_PROMPTS).toContain(prompt);
    }
  });

  it('returns at most the pool size', () => {
    expect(pickPrompts(['a', 'b'], 3).sort()).toEqual(['a', 'b']);
    expect(pickPrompts([], 3)).toEqual([]);
  });
});
