import { readFileSync } from 'node:fs';

import {
  createIosSimSnapshot,
  listAllIosSimsAsync,
  listIosDeviceTypesAsync,
  listIosRuntimesAsync,
} from '../devices/ios.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

const ALL = JSON.parse(readFileSync(new URL('./fixtures/simctl-list-all.json', import.meta.url), 'utf8'));

function simctl(all = ALL) {
  const calls: string[][] = [];
  setExecutor({
    runFile: (_file: string, args: string[]) => {
      calls.push(args);
      const section = args[2];
      return JSON.stringify(section === undefined || section === '--json' ? all : { [section]: all[section] });
    },
  });
  return calls;
}

afterEach(() => resetExecutor());

test('one simctl list serves the simulators, runtimes and device types that three separate lists give', async () => {
  const calls = simctl();
  const separate = {
    sims: await listAllIosSimsAsync({ includeUnavailable: true }),
    runtimes: await listIosRuntimesAsync(),
    deviceTypes: await listIosDeviceTypesAsync(),
  };
  expect(calls).toHaveLength(3);
  expect(separate.sims.map((sim) => sim.available)).toContain(false);
  expect(separate.runtimes).toHaveLength(2);

  calls.length = 0;
  const snapshot = createIosSimSnapshot();
  const [runtimes, deviceTypes, sims] = await Promise.all([
    listIosRuntimesAsync({ snapshot }),
    listIosDeviceTypesAsync({ snapshot }),
    snapshot.readAsync?.(),
  ]);
  expect({ sims, runtimes, deviceTypes }).toEqual(separate);
  expect(calls).toEqual([['simctl', 'list', '--json']]);
});
