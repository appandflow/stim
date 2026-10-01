import { buildPlacements, machineReadiness, placementTitle } from '@/lib/build-machines';
import type { BuildMachineReport } from '@/protocol/types';

const approved = (patch: Partial<BuildMachineReport> = {}): BuildMachineReport => ({
  machine: 'janics-mac-mini:7869',
  state: 'approved',
  offloadable: true,
  reasons: [],
  problems: [],
  capacity: { loadPerCore: 0.4 },
  ...patch,
});

describe('machineReadiness', () => {
  it('reads an approved machine as Ready, or its first reason with a remedy', () => {
    expect(machineReadiness(approved())).toMatchObject({ name: 'janics-mac-mini', title: 'Ready', tone: 'success' });
    const reasons = ['Stim build 6bbe there, e774 here', 'busy (load at or above 2/core; load 8.2/core, 2 builds)'];
    expect(
      machineReadiness(
        approved({
          offloadable: false,
          reasons,
          problems: [
            { code: 'stim-build', reason: reasons[0]! },
            { code: 'busy', reason: reasons[1]! },
          ],
        }),
      ),
    ).toEqual({
      id: 'janics-mac-mini:7869',
      name: 'janics-mac-mini',
      title: 'Stim build differs',
      remedy: 'update the build machine',
      tone: 'error',
    });
    expect(
      machineReadiness(
        approved({
          offloadable: false,
          reasons: [reasons[1]!],
          problems: [{ code: 'busy', reason: reasons[1]! }],
          capacity: { loadPerCore: 8.2 },
        }),
      ),
    ).toMatchObject({ title: 'Busy (load 8.2/core)', remedy: null, tone: 'warning' });
  });

  it('shows the pairing state of a machine that is not approved, and the reason text from an older stim', () => {
    expect(machineReadiness({ machine: 'mini', state: 'pending' })).toMatchObject({ title: 'Waiting for approval' });
    expect(machineReadiness({ machine: 'mini', state: 'approved' })).toMatchObject({ title: 'Approved' });
    expect(
      machineReadiness({
        machine: 'mini',
        state: 'approved',
        offloadable: false,
        reasons: ['CPU x86_64 there, arm64 here'],
      }),
    ).toMatchObject({ title: 'CPU x86_64 there, arm64 here', remedy: null, tone: 'error' });
  });
});

describe('buildPlacements', () => {
  it('reads the offload part of stim stats, skipping placements it does not understand', () => {
    const read = buildPlacements({
      version: 1,
      offload: {
        today: { here: 2, offloaded: 1, fellBack: 0 },
        machines: {
          'mini:7444': { today: { offloaded: 1, offloadedMs: 9000 }, total: { offloaded: 3, savedMs: -4000 } },
        },
        placements: [
          {
            at: '2026-09-30T12:00:00.000Z',
            platform: 'ios',
            decision: 'offloaded',
            machine: 'mini:7444',
            reason: 'busy',
            buildMs: 9000,
          },
          {
            at: '2026-09-30T11:00:00.000Z',
            platform: 'android',
            decision: 'fell-back',
            reason: 'not a git checkout',
            failed: true,
          },
          { at: '2026-09-30T10:00:00.000Z', platform: 'ios', decision: 'teleported', reason: '?' },
        ],
      },
    });
    expect(read?.today).toEqual({ here: 2, offloaded: 1, fellBack: 0 });
    expect(read?.machines['mini:7444']?.total).toEqual({ offloaded: 3, offloadedMs: 0, savedMs: -4000, fallbacks: 0 });
    expect(read?.placements.map(placementTitle)).toEqual(['Built on mini', 'Built here after offloading']);
    expect(read?.placements[1]?.failed).toBe(true);
  });

  it('is null for a stim that predates placements', () => {
    expect(buildPlacements({ version: 1, machine: {} })).toBeNull();
    expect(buildPlacements(null)).toBeNull();
  });
});
