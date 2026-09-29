import { machineReadiness } from '@/lib/build-machines';
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
