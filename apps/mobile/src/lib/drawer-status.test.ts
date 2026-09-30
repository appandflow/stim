import { drawerStatus, type DrawerMachine } from '@/lib/drawer-status';

const machine = (patch: Partial<DrawerMachine> = {}): DrawerMachine => ({
  id: 'a',
  name: 'MacBook Pro',
  state: {
    kind: 'open',
    protocol: 1,
    server: { home: null, stim: '1', version: '1' } as never,
    actions: null,
    capabilities: [],
    features: [],
    deviceId: null,
  },
  missing: false,
  diskTone: 'normal',
  ...patch,
});

describe('drawerStatus', () => {
  it('shows the version when every machine is healthy', () => {
    expect(drawerStatus([machine()], 'Stim 0.1.0 (4)')).toEqual({
      text: 'Stim 0.1.0 (4)',
      tone: 'normal',
      macId: null,
    });
  });

  it('reports a reconnecting machine above everything else', () => {
    const reconnecting = machine({ name: 'Mac mini', state: { kind: 'waiting', retryInMs: 4000, reason: 'closed' } });
    const critical = machine({ name: 'MacBook Pro', diskTone: 'critical' });
    expect(drawerStatus([critical, reconnecting], 'Stim 0.1.0 (4)')).toEqual({
      text: 'Reconnecting to Mac mini\u2026',
      tone: 'warn',
      macId: null,
    });
  });

  it('reports a disconnected machine the same as reconnecting', () => {
    const closed = machine({ name: 'Mac mini', state: { kind: 'closed' } });
    expect(drawerStatus([closed], 'Stim 0.1.0 (4)')).toEqual({
      text: 'Disconnected from Mac mini',
      tone: 'warn',
      macId: null,
    });
  });

  it("ignores an unpaired (missing) machine's connection state", () => {
    const missing = machine({ name: 'Old Mac', state: { kind: 'closed' }, missing: true });
    expect(drawerStatus([missing], 'Stim 0.1.0 (4)')).toEqual({
      text: 'Stim 0.1.0 (4)',
      tone: 'normal',
      macId: null,
    });
  });

  it('ranks critical disk above a disk warning', () => {
    const critical = machine({ id: 'c', name: 'Mac mini', diskTone: 'critical' });
    const warn = machine({ id: 'w', name: 'MacBook Pro', diskTone: 'warn' });
    expect(drawerStatus([warn, critical], 'Stim 0.1.0 (4)')).toEqual({
      text: 'Mac mini: low disk',
      tone: 'critical',
      macId: 'c',
    });
  });

  it('reports a disk warning, tappable to that machine', () => {
    const warn = machine({ id: 'w', name: 'MacBook Pro', diskTone: 'warn' });
    expect(drawerStatus([warn], 'Stim 0.1.0 (4)')).toEqual({
      text: 'MacBook Pro: low disk',
      tone: 'warn',
      macId: 'w',
    });
  });
});
