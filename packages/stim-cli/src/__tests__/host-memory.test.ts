import {
  readHostMemoryPressure,
  hostMemoryPressureAdvice,
  memoryCulpritsUnderAsync,
  reportMemoryCulprits,
} from '../host-memory.ts';
import { iosSimulatorFailureAdvice } from '../devices/ios.ts';
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

const TOP_FSEVENTSD = ['PID    MEM    COMMAND', '76886  63G    fseventsd', '2265   1722M  com.apple.WebKit', ''].join(
  '\n',
);

function pendingTop() {
  let finish: (output: string | null) => void = () => {};
  const topReads = vi.fn<(file: string) => Promise<string | null>>(() => new Promise((resolve) => (finish = resolve)));
  setExecutor({ runFileQuietAsync: topReads });
  return { topReads, finish: (output: string | null) => finish(output) };
}

test.skipIf(process.platform !== 'darwin')(
  'reporting memory culprits returns before top finishes and emits the advice when it does',
  async () => {
    const { topReads, finish } = pendingTop();
    const emitted: string[] = [];
    reportMemoryCulprits('warning', (advice) => emitted.push(advice));
    expect(topReads).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);
    finish(TOP_FSEVENTSD);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]).toContain('fseventsd (pid 76886) uses');
    expect(emitted[0]).toContain('sudo killall fseventsd');
  },
);

test.skipIf(process.platform !== 'darwin')(
  'reporting memory culprits stays silent when top fails or pressure is not elevated',
  async () => {
    const { topReads, finish } = pendingTop();
    const emitted: string[] = [];
    reportMemoryCulprits('normal', (advice) => emitted.push(advice));
    reportMemoryCulprits(null, (advice) => emitted.push(advice));
    expect(topReads).not.toHaveBeenCalled();
    reportMemoryCulprits('critical', (advice) => emitted.push(advice));
    finish(null);
    await vi.waitFor(() => expect(topReads).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(emitted).toEqual([]);
  },
);

test.skipIf(process.platform !== 'darwin')(
  'culprit reads share one top run for 30 seconds and read again afterwards',
  async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const topReads = vi.fn<(file: string) => Promise<string | null>>(async () => TOP_FSEVENTSD);
      setExecutor({ runFileQuietAsync: topReads });
      const [first, second] = await Promise.all([
        memoryCulpritsUnderAsync('warning'),
        memoryCulpritsUnderAsync('critical'),
      ]);
      expect(first).toEqual(second);
      expect(first?.[0]?.name).toBe('fseventsd');
      vi.setSystemTime(29_000);
      await memoryCulpritsUnderAsync('warning');
      expect(topReads).toHaveBeenCalledTimes(1);
      vi.setSystemTime(31_000);
      await memoryCulpritsUnderAsync('warning');
      expect(topReads).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'the iOS simulator failure advice names the culprit read from top',
  async () => {
    setExecutor({
      runFile: () => '2',
      runFileQuietAsync: async () => TOP_FSEVENTSD,
    });
    const advice = await iosSimulatorFailureAdvice(getExecutor());
    expect(advice).toContain('warning host memory pressure');
    expect(advice).toContain('fseventsd (pid 76886) uses');
  },
);
