import { readFileSync } from 'node:fs';
import type { StatusPayload as ServerStatus } from '@stim-cli/core/state';
import fixture from '../../../apps/mobile/mock-server/fixtures/status.json' with { type: 'json' };
import { oversightTitle as phoneTitle } from '../../../apps/mobile/src/lib/oversight.ts';
import { repositoryRoots, workspaceTitle } from '../../../apps/mobile/src/lib/workspace-names.ts';
import type { StatusPayload as PhoneStatus } from '../../../apps/mobile/src/protocol/types.ts';
import { OVERSIGHT_CATEGORIES, oversightTitle } from '../src/oversight.ts';
import { PUSH_EVENTS } from '../src/protocol.ts';

const withoutHeader = (path: string) => {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  return text.slice(text.indexOf('*/') + 2);
};

describe("the phone's copy of the notification rules", () => {
  it('is the same code as the server copy', () => {
    expect(withoutHeader('../../../apps/mobile/src/lib/oversight.ts')).toBe(withoutHeader('../src/oversight.ts'));
  });

  it('knows the same categories stim-server pushes', () => {
    expect([...OVERSIGHT_CATEGORIES]).toEqual([...PUSH_EVENTS]);
  });

  it('names each workspace as the home screen does', () => {
    const status = fixture.payload as unknown as PhoneStatus;
    const roots = repositoryRoots(status);
    expect(status.environments.length).toBeGreaterThan(1);
    for (const env of status.environments) {
      expect(oversightTitle(env, status as unknown as ServerStatus)).toBe(workspaceTitle(env, roots));
      expect(phoneTitle(env, status)).toBe(workspaceTitle(env, roots));
    }
  });
});
