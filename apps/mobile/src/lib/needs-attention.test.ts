import fixture from '../../../desktop/Tests/StimKitTests/Fixtures/needs-attention-vectors.json';

import { needsAttention, type NeedsAttentionInput, type NeedsAttentionItem } from '@/lib/needs-attention';

const vectors = fixture as unknown as {
  cases: { name: string; input: Omit<NeedsAttentionInput, 'now'> & { now: string }; items: NeedsAttentionItem[] }[];
};

describe('needsAttention', () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_, { input, items }) => {
    expect(needsAttention({ ...input, now: Date.parse(input.now) })).toEqual(items);
  });
});
