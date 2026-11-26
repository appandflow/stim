import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installServer } from '@stim-cli/server/release-install';
import { runCli } from '../cli/define-op.ts';
import engineOp from '../commands/engine.ts';
import { writeRecord } from '../engine-store/store.ts';

vi.mock('@stim-cli/server/release-install', () => ({
  installServer: vi.fn<typeof installServer>(),
}));

let temp: string;

beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-engine-use-target-')));
  const root = join(temp, 'engine');
  mkdirSync(root);
  vi.stubEnv('STIM_ENGINE_ROOT', root);
  vi.stubEnv('STIM_HOME', join(temp, 'home'));
  vi.stubEnv('HOME', temp);
  writeRecord(join(root, 'current.json'), {
    format: 1,
    dir: 'current',
    version: '2.0.0',
  });
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test.each(['missing path', 'regular file', 'other package'])('use refuses a %s', async (kind) => {
  const target = join(temp, 'target');
  if (kind === 'regular file') writeFileSync(target, 'package');
  if (kind === 'other package') {
    mkdirSync(target);
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'other' }));
  }
  await expect(runCli(engineOp, ['use', target], { version: '2.0.0' })).rejects.toMatchObject({
    code: 'STIM_BAD_ARG',
    remedy: 'Pass a published stim version or the directory of a built stim package.',
  });
});

test.each([
  ['ETARGET No matching version found', 'npm has no stim 1.40.0.', 'Run npm view stim versions to list them.'],
  [
    'release has no stim with its stim build',
    'stim 1.40.0 predates the engine store.',
    'Choose a later version; npm view stim versions lists them.',
  ],
])('use explains a version failure: %s', async (message, refusal, remedy) => {
  vi.mocked(installServer).mockRejectedValueOnce(new Error(message));
  await expect(runCli(engineOp, ['use', '1.40.0'], { version: '2.0.0' })).rejects.toMatchObject({
    code: 'STIM_ENGINE_REFUSED',
    message: `${refusal} ${remedy}`,
    remedy,
  });
});
