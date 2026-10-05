import { isDeepStrictEqual } from 'node:util';
import type { StatusPayload as ServerStatus } from '@stim-cli/core/state';
import fixture from '../../../apps/mobile/mock-server/fixtures/status.json' with { type: 'json' };
import { repositoryRoots, workspaceTitle } from '../../../apps/mobile/src/lib/workspace-names.ts';
import type { StatusPayload as PhoneStatus } from '../../../apps/mobile/src/protocol/types.ts';
import vectors from '../../../apps/desktop/Tests/StimKitTests/Fixtures/needs-attention-vectors.json' with { type: 'json' };
import {
  needsAttention,
  OVERSIGHT_CATEGORIES,
  oversightTitle,
  type AttentionMessage,
  type NeedsAttentionInput,
} from '@stim-cli/core/oversight';
import { PUSH_EVENTS } from '../src/protocol.ts';

describe('shared notification rules', () => {
  it('knows the same categories stim-server pushes', () => {
    expect([...OVERSIGHT_CATEGORIES]).toEqual([...PUSH_EVENTS]);
  });

  it('names each workspace as the home screen does', () => {
    const status = fixture.payload as unknown as PhoneStatus;
    const roots = repositoryRoots(status);
    expect(status.environments.length).toBeGreaterThan(1);
    for (const env of status.environments) {
      expect(oversightTitle(env, status as unknown as ServerStatus)).toBe(workspaceTitle(env, roots));
    }
  });

  it('lists what the phone and Stim Desktop list', () => {
    const cases = (
      vectors as unknown as {
        cases: { name: string; input: NeedsAttentionInput & { now: string }; items: unknown[] }[];
      }
    ).cases;
    const differing = cases
      .filter(({ input, items }) => !isDeepStrictEqual(needsAttention({ ...input, now: Date.parse(input.now) }), items))
      .map(({ name }) => name);
    expect(differing).toEqual([]);
  });

  it('lets a formatter change bodies without changing selected items, remedies or ordering', () => {
    const messages: AttentionMessage[] = [];
    for (const { input, items } of vectors.cases) {
      const formatted = needsAttention({ ...input, now: Date.parse(input.now) } as NeedsAttentionInput, (message) => {
        messages.push(message);
        return 'localized';
      });
      expect(formatted).toEqual(items.map((item) => Object.assign({}, item, { body: 'localized' })));
    }
    expect(messages).toContainEqual({
      kind: 'diagnostic-loop',
      platform: 'ios',
      count: 3,
      file: 'AppDelegate.swift',
      line: 71,
      language: 'Swift',
    });
    expect(messages).toContainEqual(expect.objectContaining({ kind: 'stuck', minutes: 20, green: 'ios' }));
  });
});
