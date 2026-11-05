import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectStimVersions } from '../diagnostics/stim-installations.ts';

test('concurrent Stim installation readers use their caller directory and environment', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-doctor-version-context-'));
  const cwd = process.cwd();
  const originalEnv = { ...process.env };
  const windows = process.platform === 'win32';
  const name = windows ? 'stim.cmd' : 'stim';
  const fixtures = ['2.1.0', '3.2.0'].map((version) => {
    const root = join(base, version);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, 'marker'), version);
    writeFileSync(
      join(bin, name),
      windows
        ? `@echo off\r\nif not "%STIM_TEST_VERSION%"=="${version}" exit /b 1\r\nif not exist marker exit /b 1\r\necho ${version}\r\n`
        : `#!/bin/sh\nif [ "$STIM_TEST_VERSION" = "${version}" ] && [ -f marker ]; then\nprintf "${version}\\n"\nelse\nprintf "0.0.0\\n"\nfi\n`,
    );
    if (!windows) chmodSync(join(bin, name), 0o755);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH') delete env[key];
    }
    env[windows ? 'Path' : 'PATH'] = 'bin';
    env.STIM_TEST_VERSION = version;
    return { root, version, env };
  });
  try {
    const reports = await Promise.all(
      fixtures.map(({ root, env }) => inspectStimVersions('1.0.0', { cwd: root, env, runningPath: join('bin', name) })),
    );
    for (const [index, { root, version }] of fixtures.entries()) {
      expect(reports[index]).toMatchObject({
        runningPath: realpathSync(join(root, 'bin', name)),
        resolved: { path: join(root, 'bin', name), version },
        highestVersion: version,
      });
    }
    expect(process.cwd()).toBe(cwd);
    expect({ ...process.env }).toEqual(originalEnv);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
