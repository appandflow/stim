import type { StatusPayload } from '@/protocol/types';
import { resolveWorkspaceLink, workspaceIntentPath, type WorkspaceLinkMachine } from '@/lib/workspace-links';

const machine = '871c7262-f6bc-469a-b822-15da928350ee';
const other = '61d025cb-e23c-434d-8e47-88db533811eb';
const workspace = '0123456789abcdef';
const url = `https://stim.appandflow.com/open?v=1&machine=${machine}&workspace=${workspace}`;
const status: StatusPayload = {
  capacity: { liveCount: 0, committedMb: 0, totalMemoryMb: 1024, overCapacity: false },
  deviceLeases: [],
  simctlAvailable: true,
  environments: [{ path: '/same/app', live: false, memoryMb: 0, warnings: [], issues: [], workspaceId: workspace }],
};
const paired = (id: string, serverId = machine): WorkspaceLinkMachine => {
  const state: Extract<WorkspaceLinkMachine['state'], { kind: 'open' }> = {
    kind: 'open',
    server: { id: serverId, name: id, version: '1', stim: '1' },
    protocol: 1,
    capabilities: ['read'],
    features: [],
    actions: [],
    deviceId: id,
  };
  return { mac: { id, serverId }, state, status, statusSource: state, cachedSeenAt: null };
};

test('home identity selects the same workspace through installation-local pairing IDs', () => {
  const destination = { machine, workspace, platform: 'ios' as const, slot: 'ipad' };
  for (const id of ['phone-pairing-one', 'phone-pairing-two'])
    expect(resolveWorkspaceLink(destination, [paired('other-mac', other), paired(id)])).toEqual({
      kind: 'ready',
      macId: id,
      path: status.environments[0].path,
      platform: 'ios',
      slot: 'ipad',
    });
  expect(resolveWorkspaceLink(destination, [paired('same-path-different-home', other)])).toEqual({
    kind: 'unknown-machine',
  });
});

test('links wait for this authenticated home and refuse missing workspaces', () => {
  const link = { machine, workspace };
  const mac = paired('a');
  expect(resolveWorkspaceLink(link, [{ ...mac, statusSource: paired('old', other).statusSource }])).toEqual({
    kind: 'pending',
  });
  expect(resolveWorkspaceLink(link, [{ ...mac, statusSource: paired('prior-connection').statusSource }])).toEqual({
    kind: 'pending',
  });
  expect(resolveWorkspaceLink(link, [{ ...mac, cachedSeenAt: 1 }])).toEqual({ kind: 'pending' });
  expect(resolveWorkspaceLink(link, [{ ...mac, status: { ...status, environments: [] } }])).toEqual({ kind: 'stale' });
  expect(resolveWorkspaceLink(link, [{ ...mac, state: { kind: 'closed' } }])).toEqual({ kind: 'offline', macId: 'a' });
  expect(resolveWorkspaceLink(link, [{ ...mac, state: { kind: 'connecting' }, mac: { id: 'a' } }])).toEqual({
    kind: 'pending',
  });
  expect(
    resolveWorkspaceLink(link, [
      {
        ...mac,
        state: {
          ...mac.state,
          kind: 'open',
          server: { name: 'old', version: '1', stim: '1' },
          protocol: 1,
          features: [],
          actions: [],
          capabilities: [],
          deviceId: 'a',
        },
      },
    ]),
  ).toEqual({ kind: 'unsupported' });
});

test('native intents normalize cold and warm links without accepting endpoints or tokens', () => {
  expect(workspaceIntentPath(`${url}&endpoint=wss://evil.example&token=secret`)).toBe(
    `/open?v=1&machine=${machine}&workspace=${workspace}`,
  );
  expect(workspaceIntentPath(url.replace('https://stim.appandflow.com/open', 'stim://open'))).toBe(
    `/open?v=1&machine=${machine}&workspace=${workspace}`,
  );
  expect(workspaceIntentPath(url.replace('v=1', 'v=2'))).toBe('/open');
  expect(workspaceIntentPath(url.replace('stim.appandflow.com', 'evil.example'))).toBe('/open');
  expect(workspaceIntentPath('/pair?code=existing')).toBe('/pair?code=existing');
});
