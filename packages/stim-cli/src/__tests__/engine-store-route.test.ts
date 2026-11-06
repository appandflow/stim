import { compareVersions, route, type RouteInput } from '../../bin/route.mjs';
import { promotionRefusal } from '../engine-store/select.ts';
import type { Current } from '../engine-store/store.ts';

const current: Current = {
  format: 1,
  version: '1.50.0',
  build: '3f9a1c0d22e8',
  dir: '3f9a1c0d22e8',
  node: [{ path: '/opt/node24/bin/node', version: '24.1.0' }],
  engines: '>=22.12.0',
  channel: 'latest',
  pinned: false,
  pinReason: null,
  setBy: 'install',
  setAt: '2026-11-06T00:00:00.000Z',
};

const input = (copy: Partial<RouteInput['copy']>, engine: Partial<Current> = {}, extra: Partial<RouteInput> = {}) => ({
  args: ['node', 'stim', 'status'],
  copy: { version: '1.50.0', kind: 'machine' as const, ...copy },
  current: { ...current, ...engine },
  staged: null,
  node: '22.12.0',
  ...extra,
});

describe('compareVersions', () => {
  it.each([
    ['1.51.0-next.20261106', '1.50.9', 1],
    ['1.51.0-next.20261106', '1.51.0', -1],
    ['1.51.0-next.10', '1.51.0-next.9', 1],
    ['1.10.0', '1.9.0', 1],
  ])('orders %s against %s', (left, right, sign) => {
    expect(Math.sign(compareVersions(left, right) ?? 0)).toBe(sign);
  });
});

describe('route', () => {
  it('leaves the copy alone when no engine is installed', () => {
    expect(route({ ...input({}), current: null })).toEqual({ run: 'own' });
  });

  it('refuses an engine format it cannot read and names the npm updates', () => {
    const decision = route(input({}, { format: 2 }));
    expect(decision.run).toBe('refuse');
    expect(decision.note).toMatch(/^STIM_ROUTER_TOO_OLD: .*engine format 2; run npx stim@latest/);
  });

  it('prints the copy version for --version and never promotes', () => {
    const decision = route(input({ version: '1.51.0' }, {}, { args: ['node', 'stim', '--version'] }));
    expect(decision).toEqual({ run: 'own', note: 'engine 1.50.0 (this copy 1.51.0, machine)' });
  });

  it('runs a development tree in place', () => {
    expect(route(input({ kind: 'development', version: '1.40.0' })).run).toBe('own');
  });

  it('runs an equal or older copy on the engine', () => {
    expect(route(input({ version: '1.49.0' }))).toEqual({ run: 'engine' });
  });

  it.each([
    ['machine', 'inline'],
    ['npx', 'detached'],
    ['project', 'detached'],
  ] as const)('promotes a newer %s copy %s', (kind, promote) => {
    expect(route(input({ version: '1.51.0', kind }))).toEqual({ run: 'engine', promote });
  });

  it('lets a pin beat a newer copy and names both remedies', () => {
    const decision = route(input({ version: '1.51.0' }, { pinned: true, pinReason: 'rolled back from 1.51.0' }));
    expect(decision.promote).toBeUndefined();
    expect(decision.note).toBe(
      'the engine is pinned at 1.50.0 (rolled back from 1.51.0); run stim engine update to resume updates or stim engine use 1.51.0',
    );
  });

  it('keeps a latest engine off a prerelease copy', () => {
    const decision = route(input({ version: '1.51.0-next.20261106' }));
    expect(decision.promote).toBeUndefined();
    expect(decision.note).toMatch(/run stim engine use --channel next$/);
  });

  it('runs on the engine while the copy or a newer build is staged', () => {
    const decision = route(input({ version: '1.51.0' }, {}, { staged: { version: '1.51.0' } }));
    expect(decision).toEqual({ run: 'engine', note: 'stim 1.51.0 is staged; this command runs 1.50.0' });
  });

  it('runs the engine with the first recorded Node that meets its engines range', () => {
    expect(route(input({}, { engines: '>=24.0.0' }))).toEqual({ run: 'node', node: '/opt/node24/bin/node' });
    expect(route(input({}, { engines: '>=26.0.0' })).run).toBe('own');
  });
});

describe('promotionRefusal', () => {
  it('passes a newer build on the channel', () => {
    expect(promotionRefusal({ version: '1.51.0' }, current, [], false)).toBeNull();
  });

  it('refuses a build at or below the newest bad one, unless a person asks', () => {
    const bad = [
      { build: 'aaaaaaaaaaaa', version: '1.50.1', at: '' },
      { build: 'bbbbbbbbbbbb', version: '1.51.0', at: '' },
    ];
    expect(promotionRefusal({ version: '1.51.0' }, current, bad, false)).toBe(
      '1.51.0 is marked bad (crash loop); the engine stays on 1.50.0',
    );
    expect(promotionRefusal({ version: '1.51.1' }, current, bad, false)).toBeNull();
    expect(promotionRefusal({ version: '1.51.0' }, current, bad, true)).toBeNull();
  });

  it('keeps a pinned engine and refuses a build that is not newer', () => {
    expect(promotionRefusal({ version: '1.52.0' }, { ...current, pinned: true, pinReason: 'x' }, [], false)).toMatch(
      /^the engine is pinned at 1\.50\.0/,
    );
    expect(promotionRefusal({ version: '1.50.0' }, current, [], false)).toMatch(/is not newer/);
  });
});
