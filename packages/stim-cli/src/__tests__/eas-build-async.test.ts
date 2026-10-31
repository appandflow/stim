import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { planEasDevelopmentBuild, resolveEasDevelopmentBuild } from '../engine/eas-build.ts';
import { buildLockPath, readBuildLock } from '../engine/build-lock.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

let home: string;
let root: string;
let journal: string;
const children: ChildProcess[] = [];
const stages = ['--version', 'config', 'fingerprint:generate', 'build:list', 'build:download'] as const;
const fingerprint = 'a'.repeat(40);
const profile = 'development';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-eas-async-'));
  root = join(home, 'project');
  journal = join(home, 'commands');
  mkdirSync(root);
  writeFileSync(journal, '');
  process.env.STIM_HOME = home;
});

afterEach(() => {
  resetExecutor();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

function fixture({
  cancel,
  controller,
  checkEnv = false,
}: {
  cancel?: string;
  controller?: AbortController;
  checkEnv?: boolean;
} = {}) {
  const real = getExecutor();
  const artifact = join(home, 'Fixture.apk');
  writeFileSync(artifact, 'owned artifact');
  setExecutor({
    findExecutable: () => '/eas',
    runFileAsync(_file, args, opts) {
      const stage = args[0];
      return real.runFileAsync(
        process.execPath,
        [
          '-e',
          `
        const fs = require('node:fs');
        const stage = ${JSON.stringify(stage)};
        fs.appendFileSync(${JSON.stringify(journal)}, stage + '\\n');
        if (${checkEnv}) {
          if (process.env.STIM_EAS_HOST_ONLY !== undefined || process.env.STIM_EAS_CLIENT !== 'client') process.exit(1);
          if (stage === '--version' && (process.env.AGENT_DEVICE_DAEMON_BASE_URL !== undefined || process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN !== undefined)) process.exit(1);
          const expected = stage === '--version' || stage === 'config' ? 'client' : 'profile';
          if (process.env.APP_VARIANT !== expected) process.exit(1);
        }
        const outputs = {
          '--version': 'eas-cli/24.8.0 darwin-arm64 node-v22.22.2',
          config: JSON.stringify({
            buildProfile: { developmentClient: true, distribution: 'internal', env: { APP_VARIANT: 'profile' } },
            appConfig: { extra: { eas: { projectId: 'project-1' } } }
          }),
          'fingerprint:generate': JSON.stringify({ hash: ${JSON.stringify(fingerprint)} }),
          'build:list': JSON.stringify([{
            id: 'build-1', status: 'FINISHED', platform: 'ANDROID', buildProfile: 'development',
            fingerprint: { hash: ${JSON.stringify(fingerprint)} }, app: { id: 'project-1' },
            distribution: 'INTERNAL', artifacts: { applicationArchiveUrl: 'https://example.com/app.apk' }
          }]),
          'build:download': JSON.stringify({ path: ${JSON.stringify(artifact)} })
        };
        process.stderr.write('ready\\n');
        setTimeout(() => process.stdout.write(outputs[stage]), stage === ${JSON.stringify(cancel ?? '')} ? 30000 : 30);
      `,
        ],
        {
          ...opts,
          onSpawn(child) {
            children.push(child);
            opts.onSpawn?.(child);
            if (stage === cancel) child.stderr?.once('data', () => controller?.abort());
          },
        },
      );
    },
  });
  return { root, platform: 'android' as const, profile, note: () => {}, signal: controller?.signal };
}

test.each(stages)('cancelling EAS during %s stops the child and releases any artifact claim', async (stage) => {
  const controller = new AbortController();
  const plan = await planEasDevelopmentBuild(fixture());
  if (!plan.ok || !plan.cacheKey) throw new Error(JSON.stringify(plan));
  resetExecutor();
  const args = fixture({ cancel: stage, controller });
  writeFileSync(journal, '');
  await expect(resolveEasDevelopmentBuild(args)).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  expect(readBuildLock(buildLockPath('android', plan.cacheKey))).toBeNull();
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
});

test('cancelling a read-only EAS plan rejects instead of reporting a missing build', async () => {
  const controller = new AbortController();
  await expect(planEasDevelopmentBuild(fixture({ cancel: 'build:list', controller }))).rejects.toMatchObject({
    code: 'STIM_CANCELLED',
  });
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toEqual(stages.slice(0, 4));
});
