import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceStateDir } from '../index.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { machineCapacity, saturation, type MachineCapacity } from '../state/build-capacity.ts';

const IDLE: MachineCapacity = { cpus: 10, loadPerCore: 0.4, builds: 1, maxBuilds: 2, maxLoadPerCore: 2 };

describe('saturation', () => {
  it.each([
    ['a free slot and low load', IDLE, null],
    ['every slot busy', { ...IDLE, builds: 2 }, 'all 2 build slots busy'],
    ['load at the limit', { ...IDLE, loadPerCore: 2 }, 'load at or above 2/core'],
    ['no build limit and many builds', { ...IDLE, maxBuilds: 0, builds: 9 }, null],
  ])('%s', (_, capacity, reason) => {
    expect(saturation(capacity)).toBe(reason);
  });
});

describe('machineCapacity', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-capacity-'));
    process.env.STIM_HOME = home;
  });

  afterEach(() => {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('reads offload.maxLoadPerCore and concurrency.maxBuilds, with the registry default', () => {
    expect(machineCapacity()).toMatchObject({ builds: 0, maxBuilds: 0, maxLoadPerCore: 2 });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ concurrency: { maxBuilds: 3 }, offload: { maxLoadPerCore: 1.5 } }),
    );
    expect(machineCapacity()).toMatchObject({ maxBuilds: 3, maxLoadPerCore: 1.5 });
  });

  it('counts runs compiling here, not runs offloaded to a build machine', () => {
    const claim = tryAcquireClaim({ root: join(home, 'native-run'), mode: 'exclusive', label: 'native run' }).acquired!;
    const write = (project: string, activeBuild: Record<string, unknown>) => {
      mkdirSync(workspaceStateDir(join(home, project)), { recursive: true });
      writeFileSync(
        join(workspaceStateDir(join(home, project)), 'state.json'),
        JSON.stringify({ activeBuild: { ...activeBuild, claim: { root: claim.root, claimId: claim.claimId } } }),
      );
    };
    write('here', { phase: 'compile' });
    write('installing', { phase: 'install' });
    write('offloaded', {
      phase: 'compile',
      placement: { host: 'mini', phase: 'build', startedAt: 'x', phaseStartedAt: 'x' },
    });
    expect(machineCapacity().builds).toBe(1);
    releaseClaim(claim);
    expect(machineCapacity().builds).toBe(0);
  });
});
