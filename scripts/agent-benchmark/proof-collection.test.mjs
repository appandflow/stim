import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFileSync(file) {
    if (file === 'git') return '';
    if (file === 'sips') return 'pixelWidth: 320\npixelHeight: 640';
    throw new Error(`unexpected collector host call: ${file}`);
  },
}));

const argv = process.argv;
let root;
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  if (root) rmSync(root, { recursive: true, force: true });
});

it.each([
  ['literal text', "'Offline maps'", 0, true],
  ['failed wait', "'Offline maps'", 1, false],
  ['chained wait', "'Offline maps'; echo complete", 0, false],
  ['newline', "\n'Offline maps'", 0, false],
])('collects screen and recording evidence only for successful standalone %s', async (_name, text, exitCode, valid) => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'benchmark-proof-')));
  const runDir = join(root, 'run');
  const proofDir = join(runDir, 'proof');
  mkdirSync(proofDir, { recursive: true });
  const stateDir = join(root, 'agent-device');
  const runId = 'proof-run';
  const prefix = `env AGENT_DEVICE_STATE_DIR=${stateDir} AGENT_DEVICE_SESSION=${runId} agent-device`;
  const screenshotScratch = join('/tmp', `${runId}-settings.png`);
  const recordingScratch = join('/tmp', `${runId}-session.mp4`);
  const screenshot = join(proofDir, 'settings.png');
  const recording = join(proofDir, 'session.mp4');
  const commands = [
    `${prefix} open com.appandflow.trailhead --foreground --platform android --serial emulator-5554`,
    `${prefix} record start ${recordingScratch} --scope device --quality high --hide-touches`,
    `${prefix} wait text ${text}`,
    `${prefix} screenshot ${screenshotScratch}`,
    `cp ${screenshotScratch} ${screenshot}`,
    `${prefix} record stop`,
    `cp ${recordingScratch} ${recording}`,
    `${prefix} close`,
  ];
  const meta = {
    runId,
    arm: 'control',
    platform: 'android',
    variant: 'native',
    runner: 'codex',
    runnerResult: { code: 0 },
    dispatchAt: '2026-10-09T12:00:00.000Z',
    timingTarget: { key: 'android.native.control', screenReadySeconds: 180 },
    agentDevice: { stateDir, session: runId },
    deviceTargetingRequired: true,
  };
  writeFileSync(join(root, 'pins.env'), '');
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta));
  writeFileSync(
    join(runDir, 'app-alive.json'),
    JSON.stringify({ simulator: { udid: 'emulator-5554' }, proof: { valid: true, target: screenshot } }),
  );
  writeFileSync(screenshot, Buffer.from('89504e470d0a1a0a', 'hex'));
  const video = Buffer.alloc(1_000);
  video.write('ftyp', 4);
  writeFileSync(recording, video);
  writeFileSync(
    join(runDir, 'events.jsonl'),
    commands
      .map((command, index) =>
        JSON.stringify({
          arrivedAt: `2026-10-09T12:00:0${index + 1}.000Z`,
          line: JSON.stringify({
            type: 'item.completed',
            item: {
              id: `proof-${index}`,
              type: 'command_execution',
              command,
              exit_code: index === 2 ? exitCode : 0,
              aggregated_output: index === 0 ? `Session state: ${stateDir}/sessions/${runId}` : '',
            },
          }),
        }),
      )
      .join('\n'),
  );
  vi.stubEnv('STIM_BENCH_ROOT', root);
  vi.stubEnv('STIM_BENCH_FIXTURE', root);
  process.argv = [process.execPath, 'driver.mjs', 'collect', runDir];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await import('./driver.mjs');
  const result = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const missingCommand = expect.stringContaining('missing-successful-command:');
  expect(result.screen.reason).toEqual(valid ? undefined : missingCommand);
  expect(result.screen.valid).toBe(valid);
  expect(result.recording.valid).toBe(valid);
  expect(result.screen).toMatchObject(
    valid ? { waitCommandId: 'proof-2', screenshotCommandId: 'proof-3' } : { reason: missingCommand },
  );
  expect(result.recording).toMatchObject(
    valid
      ? { startCommandId: 'proof-1', stopCommandId: 'proof-5', copyCommandId: 'proof-6' }
      : { reason: 'simulator-recording-commands-missing' },
  );
  expect(result.dispatchToScreenReadySeconds).toBe(valid ? 4 : null);
});
