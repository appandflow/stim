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
  it('summarizes one connected Mac', () => {
    expect(drawerStatus([machine()])).toEqual({
      text: '1 Mac connected',
      tone: 'normal',
      macId: null,
    });
  });

  it('summarizes multiple connected Macs', () => {
    expect(drawerStatus([machine(), machine({ id: 'b' })])).toEqual({
      text: '2 Macs connected',
      tone: 'normal',
      macId: null,
    });
  });

  it.each([
    [[machine({ state: { kind: 'connecting' } })], '1 Mac, 1 offline'],
    [[machine(), machine({ id: 'b', state: { kind: 'connecting' } })], '2 Macs, 1 offline'],
  ])('counts non-open Macs as offline', (machines, text) => {
    expect(drawerStatus(machines)).toEqual({ text, tone: 'normal', macId: null });
  });

  it('reports no paired Macs', () => {
    expect(drawerStatus([])).toEqual({ text: 'No Macs paired', tone: 'normal', macId: null });
  });

  it('leaves missing Macs out of the connected count', () => {
    expect(drawerStatus([machine(), machine({ id: 'b', missing: true })]).text).toBe('1 Mac connected');
  });

  it('reports a reconnecting machine above everything else', () => {
    const reconnecting = machine({ name: 'Mac mini', state: { kind: 'waiting', retryInMs: 4000, reason: 'closed' } });
    const critical = machine({ name: 'MacBook Pro', diskTone: 'critical' });
    expect(drawerStatus([critical, reconnecting])).toEqual({
      text: 'Reconnecting to Mac mini\u2026',
      tone: 'warn',
      macId: null,
    });
  });

  it('reports a disconnected machine the same as reconnecting', () => {
    const closed = machine({ name: 'Mac mini', state: { kind: 'closed' } });
    expect(drawerStatus([closed])).toEqual({
      text: 'Disconnected from Mac mini',
      tone: 'warn',
      macId: null,
    });
  });

  it("ignores an unpaired (missing) machine's connection state", () => {
    const missing = machine({ name: 'Old Mac', state: { kind: 'closed' }, missing: true, diskTone: 'critical' });
    expect(drawerStatus([missing])).toEqual({
      text: 'No Macs paired',
      tone: 'normal',
      macId: null,
    });
  });

  it('ranks critical disk above a disk warning', () => {
    const critical = machine({ id: 'c', name: 'Mac mini', diskTone: 'critical' });
    const warn = machine({ id: 'w', name: 'MacBook Pro', diskTone: 'warn' });
    expect(drawerStatus([warn, critical])).toEqual({
      text: 'Mac mini: low disk',
      tone: 'critical',
      macId: 'c',
    });
  });

  it('reports a disk warning, tappable to that machine', () => {
    const warn = machine({ id: 'w', name: 'MacBook Pro', diskTone: 'warn' });
    expect(drawerStatus([warn])).toEqual({
      text: 'MacBook Pro: low disk',
      tone: 'warn',
      macId: 'w',
    });
  });
});
