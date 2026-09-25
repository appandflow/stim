import fixture from '../../mock-server/fixtures/status.json';

import { newlyLive, parseRecents, touchRecents } from '@/lib/recents';
import type { EnvironmentState, StatusPayload } from '@/protocol/types';

const payload = fixture.payload as StatusPayload;
const env = (path: string, live: boolean): EnvironmentState => ({ path, live, memoryMb: 0, warnings: [] });
const mac = (id: string, environments: EnvironmentState[]) => ({
  id,
  name: id,
  status: { ...payload, environments },
});
const w = (macId: string, path: string) => ({ macId, path });

describe('touchRecents', () => {
  it('moves a reopened workspace to the front instead of repeating it', () => {
    const recents = [w('a', '/one'), w('a', '/two'), w('b', '/one')];
    expect(touchRecents(recents, [w('b', '/one')])).toEqual([w('b', '/one'), w('a', '/one'), w('a', '/two')]);
  });

  it('keeps only the six newest', () => {
    const recents = Array.from({ length: 6 }, (_, i) => w('a', `/${i}`));
    const next = touchRecents(recents, [w('a', '/new')]);
    expect(next).toHaveLength(6);
    expect(next[0]).toEqual(w('a', '/new'));
    expect(next).not.toContainEqual(w('a', '/5'));
  });
});

describe('parseRecents', () => {
  it('drops unreadable storage and malformed entries', () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents('{')).toEqual([]);
    expect(parseRecents('{"macId":"a"}')).toEqual([]);
    expect(
      parseRecents(JSON.stringify([w('a', '/one'), { macId: 'a' }, null, { ...w('b', '/two'), extra: 1 }])),
    ).toEqual([w('a', '/one'), w('b', '/two')]);
  });
});

describe('newlyLive', () => {
  it('reports only workspaces that became live since the previous status', () => {
    const first = newlyLive(new Set(), [mac('a', [env('/one', true), env('/two', false)])]);
    expect(first.started).toEqual([w('a', '/one')]);

    const second = newlyLive(first.live, [mac('a', [env('/one', true), env('/two', true)])]);
    expect(second.started).toEqual([w('a', '/two')]);

    const idle = newlyLive(second.live, [mac('a', [env('/one', false), env('/two', true)])]);
    expect(idle.started).toEqual([]);
    expect(newlyLive(idle.live, [mac('a', [env('/one', true), env('/two', true)])]).started).toEqual([w('a', '/one')]);
  });
});
