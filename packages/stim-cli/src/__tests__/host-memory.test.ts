import { readHostMemoryPressure, hostMemoryPressureAdvice } from '../host-memory.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

afterEach(resetExecutor);

test.each([
  ['1\n', 'normal'],
  ['2', 'warning'],
  ['4', 'critical'],
  ['0', null],
  ['3', null],
  ['8', null],
  ['', null],
  ['permission denied', null],
])('reads macOS dispatch pressure value %j without guessing unknown states', (output, expected) => {
  const runFile = vi.fn<() => string>(() => output);
  setExecutor({ runFile });
  expect(readHostMemoryPressure(getExecutor(), 'darwin')).toBe(expected);
  expect(runFile).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
    timeoutMs: 2000,
  });
});

test('unavailable pressure stays unknown and unsupported platforms do not run sysctl', () => {
  const runFile = vi.fn<() => string>(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  setExecutor({ runFile });
  expect(readHostMemoryPressure(getExecutor(), 'darwin')).toBeNull();
  runFile.mockClear();
  expect(readHostMemoryPressure(getExecutor(), 'linux')).toBeNull();
  expect(runFile).not.toHaveBeenCalled();
});

test('only observed pressure recommends memory recovery and an optional SimSlim profile', () => {
  expect(hostMemoryPressureAdvice(null)).toBeNull();
  expect(hostMemoryPressureAdvice('normal')).toBeNull();
  for (const pressure of ['warning', 'critical'] as const) {
    expect(hostMemoryPressureAdvice(pressure)).toContain(`${pressure} host memory pressure`);
    expect(hostMemoryPressureAdvice(pressure)).toContain('stim guide lifecycle simslim');
    expect(hostMemoryPressureAdvice(pressure)).toContain('does not establish an OOM crash');
  }
});
