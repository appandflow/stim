import { buildPlacements, machineReadiness, placementReason, placementTitle } from '@/lib/build-machines';
import type { BuildMachineReport } from '@/protocol/types';

import stateVectors from '../../../desktop/Tests/StimKitTests/Fixtures/remote-machine-state-vectors.json';

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
      remedy: 'update the remote machine',
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

  it.each([
    ['approved', 'Approved', 'success', null],
    ['pending', 'Waiting for approval', 'warning', null],
    ['not-asked', 'Not asked', 'tertiary', null],
    ['revoked', 'Revoked', 'error', null],
    ['lapsed', 'Request lapsed', 'error', null],
    [
      'key-changed',
      'Different machine',
      'error',
      'if mini or its Stim home was replaced, run stim remote remove mini, then stim remote add mini on the computer this phone is paired with',
    ],
    [
      'key-unconfirmed',
      'Key not confirmed',
      'warning',
      'run stim remote list in a terminal on the computer this phone is paired with, and answer y only if the fingerprint matches the one stim setup printed on mini',
    ],
    [
      'outdated',
      'Server is outdated',
      'warning',
      'on mini, run stim service update --release <version>, then run stim remote add mini on the computer this phone is paired with',
    ],
    ['not-on-tailnet', 'Not on the tailnet', 'warning', null],
    ['tailscale-off', 'Tailscale is off', 'warning', null],
    ['unreachable', 'Unreachable', 'warning', null],
    ['invalid', 'Not a tailnet name', 'error', null],
  ])('shows state %s as %s', (state, title, tone, remedy) => {
    expect(machineReadiness({ machine: 'mini', state })).toEqual({ id: 'mini', name: 'mini', title, tone, remedy });
  });

  it('names every state with the title and tone Stim Desktop shows', () => {
    for (const { state, title, tone } of stateVectors)
      expect(machineReadiness({ machine: 'mini', state })).toMatchObject({
        title,
        tone: tone === 'neutral' ? 'tertiary' : tone,
      });
  });

  it('shows the title and remedy of the diagnosis a report carries, with the tone of its state', () => {
    const diagnosis = {
      layer: 'compat' as const,
      code: 'server-outdated',
      title: 'Server is outdated',
      message: 'The stim-server on mini speaks an older protocol.',
      remedy: 'On mini, run `stim-server service update --release 1.40.0`, then run `stim remote add mini` here.',
    };
    expect(machineReadiness({ machine: 'mini', state: 'outdated', diagnosis })).toEqual({
      id: 'mini',
      name: 'mini',
      title: 'Server is outdated',
      tone: 'warning',
      remedy: diagnosis.remedy,
    });
  });

  it('shows a state from a newer stim as Unknown', () => {
    expect(machineReadiness({ machine: 'mini', state: 'from-the-future' })).toMatchObject({
      title: 'Unknown',
      tone: 'tertiary',
      remedy: null,
    });
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
    const fellBack = { ...read!.placements[1]!, machine: 'old-mini', reason: 'old-mini: Stim build 6bbe there' };
    expect(placementReason(fellBack)).toBe('Stim build 6bbe there');
    expect(placementReason(read!.placements[0]!)).toBe('busy');
  });

  it('is null for a stim that predates placements', () => {
    expect(buildPlacements({ version: 1, machine: {} })).toBeNull();
    expect(buildPlacements(null)).toBeNull();
  });
});
