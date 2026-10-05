import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

if (process.env.STIM_HOME) throw new Error('Unset STIM_HOME; the pilot uses the regular Stim home.');
if (!process.env.PILOT_WORKSPACE || !process.env.PILOT_UDID || !process.env.PILOT_SLOT) {
  throw new Error('Set PILOT_WORKSPACE, PILOT_SLOT and PILOT_UDID for the retained owned fixture.');
}
const workspace = realpathSync(process.env.PILOT_WORKSPACE);
const status = JSON.parse(execFileSync('stim', ['status', '--json'], { cwd: workspace, encoding: 'utf8' }));
const environment = status.environments.find((entry) => entry.path === workspace);
const device =
  process.env.PILOT_SLOT === 'default'
    ? environment?.ios
    : environment?.slots?.find((entry) => entry.slot === process.env.PILOT_SLOT)?.ios;
if (!device?.owned || device.udid !== process.env.PILOT_UDID || device.state !== 'Booted') {
  throw new Error(
    'Stim must already own and have booted this exact fixture; the pilot never chooses or boots another.',
  );
}
if (!environment.metro?.running || device.app?.id !== 'com.appandflow.stim.dev' || device.app.state !== 'running') {
  throw new Error('Start and verify the Stim Dev fixture and its Metro through Stim before running the pilot.');
}
const result = spawnSync('pnpm', ['--ignore-workspace', 'exec', 'e2e', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PILOT_METRO_PORT: String(environment.metro.port), E2E_TELEMETRY_DISABLED: '1' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
