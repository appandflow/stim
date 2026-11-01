import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('units advance fake deadlines, integration exceptions keep real clocks, and lint rejects unit opt-outs', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'stim-clock-policy-'));
  const source = join(fixture, 'packages', 'clock', '__tests__');
  mkdirSync(source, { recursive: true });
  const unit = join(source, 'clock.test.ts');
  const integration = join(source, 'clock.integration.test.ts');
  const config = join(fixture, 'vitest.config.mjs');
  const lintConfig = join(fixture, '.oxlintrc.json');
  const report = join(fixture, 'result.json');
  try {
    writeFileSync(
      unit,
      `test('logical deadline', () => {
      let fired = false;
      setTimeout(() => { fired = true; }, 60_000);
      expect(fired).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(fired).toBe(true);
    });`,
    );
    writeFileSync(
      integration,
      `test('real integration clock', async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(vi.isFakeTimers()).toBe(false);
    });`,
    );
    writeFileSync(
      config,
      `import base from ${JSON.stringify(pathToFileURL(join(root, 'vitest.config.ts')).href)};
      export default { ...base, root: ${JSON.stringify(root)}, test: {
        ...base.test, include: ${JSON.stringify([unit, integration].map((path) => path.replaceAll('\\', '/')))}, maxWorkers: 1
      } };`,
    );
    const run = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        config,
        '--reporter=json',
        '--outputFile',
        report,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ numPassedTests: 2, numFailedTests: 0 });

    writeFileSync(
      unit,
      `import { setTimeout as sleep } from 'node:timers/promises';
      test('unit opt-out', async () => { vi.useRealTimers(); await sleep(1); expect(vi.isFakeTimers()).toBe(false); });`,
    );
    writeFileSync(
      integration,
      `test('integration opt-out', () => { vi.useRealTimers(); expect(vi.isFakeTimers()).toBe(false); });`,
    );
    writeFileSync(lintConfig, readFileSync(join(root, '.oxlintrc.json')));
    const lint = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/oxlint/bin/oxlint'),
        '-c',
        lintConfig,
        '--disable-nested-config',
        '-f',
        'json',
        unit,
        integration,
      ],
      {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(lint.status).not.toBe(0);
    const { diagnostics } = JSON.parse(lint.stdout);
    expect(diagnostics.some((entry) => entry.code.includes('no-restricted-properties'))).toBe(true);
    expect(diagnostics.some((entry) => entry.code.includes('no-restricted-imports'))).toBe(true);
    expect(diagnostics.some((entry) => entry.filename.endsWith('clock.integration.test.ts'))).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
