import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceStateDir } from '@stim-cli/core';
import { runCli } from '../cli/define-op.ts';
import agentDevice from '../commands/agent-device.ts';
import { withDrainingCancellation } from '../engine/operation-state.ts';

vi.mock('../run-operation.ts', () => ({ runOperation: async () => ({ admitted: 'revive' }) }));
vi.mock('../commands/ios.ts', () => ({
  runIosOperation: vi.fn<typeof import('../commands/ios.ts').runIosOperation>(),
}));
vi.mock('../devices/ios.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../devices/ios.ts')>()),
  listAllIosSimsAsync: vi.fn<typeof import('../devices/ios.ts').listAllIosSimsAsync>(async () => []),
  resolveOwnedIosSim: vi.fn<typeof import('../devices/ios.ts').resolveOwnedIosSim>(() => ({
    sim: {
      udid: 'U1',
      name: 'stim-app',
      state: 'Shutdown',
      runtime: 'iOS-26',
      deviceTypeIdentifier: 'iPhone',
      available: true,
    },
  })),
}));
import { runIosOperation } from '../commands/ios.ts';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-agent-revive-')));
  const root = join(home, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_DAEMON', 'off');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 2,
      projects: {
        [root]: { metroPort: 8082, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
      },
      repos: {},
    }),
  );
  mkdirSync(workspaceStateDir(root), { recursive: true });
  writeFileSync(
    join(workspaceStateDir(root), 'state.json'),
    JSON.stringify({
      devServerStop: { reason: 'idle', at: '2026-11-01T10:30:00.000Z', idleMinutes: 15 },
      launches: {
        ios: {
          appId: 'com.example.app',
          deviceId: 'U1',
          metroPort: 8082,
          release: true,
          launchedAt: '2026-11-01T10:00:00.000Z',
        },
      },
    }),
  );
  const bin = join(home, 'agent-device', 'bin', 'agent-device.mjs');
  mkdirSync(join(home, 'agent-device', 'bin'), { recursive: true });
  writeFileSync(join(home, 'agent-device', 'package.json'), JSON.stringify({ version: '0.21.35' }));
  writeFileSync(
    bin,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(home, 'ran'))}, '');`,
  );
  vi.stubEnv('STIM_AGENT_DEVICE_BIN', bin);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

test.each(['returned failure', 'AbortError'] as const)(
  'automatic revive interrupted with %s emits one cancellation and exits 130',
  async (outcome) => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => void out.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('unexpected process.exit');
    });
    vi.mocked(runIosOperation).mockImplementation(async (context, _root, _options, _deps, onFailure) =>
      withDrainingCancellation(context, context.signal, async () => {
        process.emit('SIGINT');
        if (outcome === 'AbortError') throw new DOMException('Aborted', 'AbortError');
        onFailure?.({ code: 'STIM_CANCELLED', message: 'The run was cancelled.', remedy: null });
        return null;
      }),
    );
    await runCli(agentDevice, ['snapshot', '--json'], { version: '0.0.0' });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ code: 'STIM_CANCELLED' });
    expect(process.exitCode).toBe(130);
    expect(runIosOperation).toHaveBeenCalled();
    expect(existsSync(join(home, 'ran'))).toBe(false);
  },
);
