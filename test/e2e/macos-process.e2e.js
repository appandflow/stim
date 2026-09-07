import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test(
  'macOS sandbox preserves collector ownership and refuses denied or zombie evidence',
  { skip: process.platform !== 'darwin' },
  () => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'stim-process-sandbox-')));
    try {
      const checker = join(temporary, 'check');
      execFileSync(
        '/usr/bin/clang',
        [
          '-std=c11',
          '-Wall',
          '-Wextra',
          '-Werror',
          fileURLToPath(new URL('./fixtures/macos-process-check.c', import.meta.url)),
          '-o',
          checker,
        ],
        { timeout: 10_000 },
      );
      assert.match(execFileSync(checker, { encoding: 'utf8' }), /identity and argument bounds passed/);
      const sentinel = join(temporary, 'secret');
      writeFileSync(sentinel, 'must stay unreadable');
      for (const mode of ['allowed', 'denied']) {
        const policy = `(version 1)(allow default)(deny file-read-data (literal ${JSON.stringify(sentinel)}))${mode === 'denied' ? '(deny process-info*)' : ''}`;
        const output = execFileSync(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            policy,
            process.execPath,
            fileURLToPath(new URL('./fixtures/macos-process-smoke.mjs', import.meta.url)),
            mode,
            sentinel,
            checker,
          ],
          {
            timeout: 30_000,
            encoding: 'utf8',
            env: { ...process.env, STIM_HOME: join(temporary, mode) },
          },
        );
        assert.match(output, new RegExp(`sandbox process ${mode} passed`));
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
