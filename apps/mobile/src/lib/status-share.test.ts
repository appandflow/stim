import fixture from '../../mock-server/fixtures/status.json';

import { mergeWorkspaces } from '@/lib/home';
import { share, shareItems, shareStatus } from '@/lib/status-share';
import type { StatusPayload } from '@/protocol/types';

const payload = fixture.payload as StatusPayload;
const clone = (): StatusPayload => JSON.parse(JSON.stringify(payload)) as StatusPayload;

describe('shareStatus', () => {
  it('returns the previous status for a push equal to it', () => {
    expect(shareStatus(payload, clone())).toBe(payload);
  });

  it('keeps every unchanged environment and replaces only the changed one', () => {
    const next = clone();
    const changed = next.environments[2];
    changed.logs = { dir: changed.logs?.dir ?? '/logs', errorsSinceMarker: 99 };
    const shared = shareStatus(payload, next);
    expect(shared).not.toBe(payload);
    shared.environments.forEach((env, i) => {
      if (i === 2) expect(env).not.toBe(payload.environments[2]);
      else expect(env).toBe(payload.environments[i]);
    });
    expect(shared.environments[2].logs?.errorsSinceMarker).toBe(99);
    expect(shared.environments[2].warnings).toBe(payload.environments[2].warnings);
    expect(shared.capacity).toBe(payload.capacity);
    expect(shared.deviceLeases).toBe(payload.deviceLeases);
  });

  it('matches environments by path when one is added or they reorder', () => {
    const next = clone();
    next.environments.reverse();
    next.environments.push({ path: '/new', live: false, memoryMb: 0, warnings: [] });
    const shared = shareStatus(payload, next);
    const byPath = new Map(payload.environments.map((env) => [env.path, env]));
    for (const env of shared.environments.slice(0, -1)) expect(env).toBe(byPath.get(env.path));
    expect(shared.environments.map((env) => env.path)).toEqual(next.environments.map((env) => env.path));
  });

  it('treats an added or removed field as a change', () => {
    const prev = { a: 1, b: undefined as number | undefined };
    expect(share(prev, { a: 1, c: undefined })).not.toBe(prev);
    expect(share([1, 2], [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('shareItems', () => {
  const items = (status: StatusPayload) => mergeWorkspaces([{ id: 'm', name: 'Mac', status }]);

  it('reuses the items of unchanged environments', () => {
    const prev = items(payload);
    const next = clone();
    next.environments[0].memoryMb += 1;
    const shared = shareItems(prev, items(shareStatus(payload, next)));
    const changedKey = `m\n${next.environments[0].path}`;
    for (const item of shared) {
      const old = prev.find((candidate) => candidate.key === item.key);
      if (item.key === changedKey) expect(item).not.toBe(old);
      else expect(item).toBe(old);
    }
  });

  it('returns the previous list when every item is unchanged', () => {
    const prev = items(payload);
    expect(shareItems(prev, items(payload))).toBe(prev);
  });
});
