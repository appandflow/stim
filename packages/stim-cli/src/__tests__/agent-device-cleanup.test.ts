import { closeOwnedDeviceSessions, parseAgentDeviceSessions } from '../agent-device-cleanup.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

const ios = { name: 'ios-task', platform: 'ios', device_udid: 'U1', id: 'U1', createdAt: 1789292795715 };
const android = { name: 'android-task', platform: 'android', id: 'emulator-5554', createdAt: 1789292795716 };
const payload = (sessions: unknown[]) => JSON.stringify({ success: true, data: { sessions } });
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
});

test('parses live CLI records without treating malformed or cross-platform identities as targets', () => {
  expect(
    parseAgentDeviceSessions(
      payload([
        ios,
        android,
        null,
        { ...ios, platform: 'macos' },
        { ...ios, id: 'OTHER' },
        { ...ios, createdAt: undefined },
        { ...ios, name: '' },
        { ...ios, device_udid: undefined },
      ]),
    ),
  ).toEqual([{ name: ios.name, platform: 'ios', id: 'U1', createdAt: ios.createdAt }, android]);
  for (const output of ['oops', '{}', '{"success":false,"data":{"sessions":[]}}']) {
    expect(() => parseAgentDeviceSessions(output)).toThrow(/JSON|successful session list/);
  }
});

function executor(lists: string[], close?: (args: string[]) => string) {
  const calls: string[][] = [];
  setExecutor({
    runQuiet: () => '/bin/agent-device',
    runFile: (_file, args, options) => {
      calls.push(args);
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(5000);
      expect(options.killSignal).toBe('SIGKILL');
      if (args[0] === 'session') return lists.length > 1 ? lists.shift() : lists[0];
      return close?.(args) ?? '{"success":true}';
    },
  });
  return calls;
}

test.each([
  [{ platform: 'ios' as const, id: 'U1' }, ios, '--udid'],
  [{ platform: 'android' as const, id: 'emulator-5554' }, android, '--serial'],
])('closes only exact matching sessions with a rejecting target guard: %j', (device, session, selector) => {
  const calls = executor([payload([ios, android, { ...ios, name: 'unrelated', device_udid: 'U10', id: 'U10' }])]);
  const owned = vi.fn<() => boolean>(() => true);
  closeOwnedDeviceSessions(device, owned);
  expect(calls.filter((args) => args[0] === 'close')).toEqual([
    [
      'close',
      '--session',
      session.name,
      '--session-lock',
      'reject',
      '--platform',
      device.platform,
      selector,
      device.id,
      '--json',
      '--daemon-transport',
      'socket',
    ],
  ]);
  expect(owned).toHaveBeenCalledOnce();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`closed agent-device session ${session.name}`));
});

test.each([
  { current: [] },
  { current: [{ ...ios, id: 'U2', device_udid: 'U2' }] },
  { current: [{ ...ios, createdAt: ios.createdAt + 1 }] },
])('does not close a disappeared, rebound or recreated session: %j', ({ current }) => {
  const calls = executor([payload([ios]), payload(current)]);
  closeOwnedDeviceSessions({ platform: 'ios', id: 'U1' }, () => true);
  expect(calls.some((args) => args[0] === 'close')).toBe(false);
});

test('does not close after device ownership changes', () => {
  const calls = executor([payload([ios])]);
  closeOwnedDeviceSessions({ platform: 'ios', id: 'U1' }, () => false);
  expect(calls.some((args) => args[0] === 'close')).toBe(false);
});

test('contains a failed close and still closes the next matching session', () => {
  const calls = executor([payload([ios, { ...ios, name: 'second' }])], (args) => {
    if (args.includes(ios.name)) throw new Error('timed out');
    return '{"success":true}';
  });
  closeOwnedDeviceSessions({ platform: 'ios', id: 'U1' }, () => true);
  expect(calls.filter((args) => args[0] === 'close')).toHaveLength(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('could not close agent-device session ios-task'));
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('closed agent-device session second'));
});

test('skips absent CLI and contains invalid inventory and unsuccessful close responses', () => {
  const runFile = vi.fn<() => string>();
  setExecutor({ runQuiet: () => null, runFile });
  closeOwnedDeviceSessions({ platform: 'ios', id: 'U1' }, () => true);
  expect(runFile).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
  executor(['garbage']);
  closeOwnedDeviceSessions({ platform: 'ios', id: 'U1' }, () => true);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('could not list agent-device sessions'));
  executor([payload([ios])], () => '{"success":false}');
  closeOwnedDeviceSessions({ platform: 'ios', id: 'U1' }, () => true);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('could not close agent-device session'));
});

test('stops invoking agent-device once the per-device budget is exhausted', () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const calls = executor([payload([ios, { ...ios, name: 'second' }])], () => {
    now += 15000;
    return '{"success":true}';
  });
  closeOwnedDeviceSessions({ platform: 'ios', id: 'U1' }, () => true);
  expect(calls).toHaveLength(3);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('agent-device cleanup timed out'));
});
