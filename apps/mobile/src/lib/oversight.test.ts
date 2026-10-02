import fixture from '../../../desktop/Tests/StimKitTests/Fixtures/needs-attention-vectors.json';

import { needsAttention, type NeedsAttentionInput, type NeedsAttentionItem } from '@stim-cli/core/oversight';

const vectors = fixture as unknown as {
  cases: {
    name: string;
    input: Omit<NeedsAttentionInput, 'now' | 'environments'> & { now: string; environments: unknown[] };
    items: NeedsAttentionItem[];
  }[];
};

describe("the server's needsAttention, which the phone carries a copy of", () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_, { input, items }) => {
    expect(needsAttention({ ...input, now: Date.parse(input.now) } as NeedsAttentionInput)).toEqual(items);
  });
});
