import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { machineCapacity } from '../state/build-capacity.ts';
import { derivedBuildCap } from '../state/config.ts';

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

  it('reads server.maxLoadPerCore and concurrency.maxBuilds, deriving the build cap when it is unset', () => {
    expect(machineCapacity()).toMatchObject({ builds: 0, maxBuilds: derivedBuildCap(), maxLoadPerCore: 2 });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ concurrency: { maxBuilds: 3 }, server: { maxLoadPerCore: 1.5 } }),
    );
    expect(machineCapacity()).toMatchObject({ maxBuilds: 3, maxLoadPerCore: 1.5 });
  });
});
