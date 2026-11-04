import { expect, test } from 'vitest';
import { cachedPeerNode } from '../src/peer-node.ts';

test('concurrent lookups of one address share one lookup, and a found node is reused until it expires', async () => {
  let clock = 0;
  const asked: string[] = [];
  const answers = new Map<string, (node: string | null) => void>();
  const peerNode = cachedPeerNode(
    (_request: null, address: string) => {
      asked.push(address);
      return new Promise<string | null>((resolve) => answers.set(address, resolve));
    },
    { ttlMs: 30_000, now: () => clock },
  );

  const together = [peerNode(null, '100.64.0.2'), peerNode(null, '100.64.0.2')];
  void peerNode(null, '100.64.0.3');
  expect(asked).toEqual(['100.64.0.2', '100.64.0.3']);
  answers.get('100.64.0.2')?.('n1');
  expect(await Promise.all(together)).toEqual(['n1', 'n1']);

  clock = 29_999;
  expect(await peerNode(null, '100.64.0.2')).toBe('n1');
  expect(asked).toHaveLength(2);

  clock = 30_000;
  const renewed = peerNode(null, '100.64.0.2');
  expect(asked).toHaveLength(3);
  answers.get('100.64.0.2')?.('n2');
  expect(await renewed).toBe('n2');
});

test('a lookup that finds nothing is not remembered, so the next request asks again', async () => {
  const answers: (string | null)[] = [null, 'n1'];
  const peerNode = cachedPeerNode(async () => answers.shift() ?? null);
  expect(await peerNode(null, '100.64.0.2')).toBeNull();
  expect(await peerNode(null, '100.64.0.2')).toBe('n1');
  expect(await peerNode(null, '100.64.0.2')).toBe('n1');
  expect(answers).toEqual([]);
});
