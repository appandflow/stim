import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIosApp } from '../engine/app-install.ts';

test.skipIf(process.platform === 'win32')(
  'a simulator install leaves the event loop free while simctl runs (POSIX executable stub; skipped on win32)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-install-loop-'));
    const previousPath = process.env.PATH;
    try {
      writeFileSync(join(dir, 'xcrun'), '#!/bin/sh\nsleep 0.5\n', { mode: 0o755 });
      process.env.PATH = `${dir}:${previousPath}`;
      let ticks = 0;
      const timer = setInterval(() => (ticks += 1), 20);
      const installed = await installIosApp({ udid: 'U1', appPath: join(dir, 'App.app') }).finally(() =>
        clearInterval(timer),
      );
      expect(installed).toEqual({ ok: true, appPath: join(dir, 'App.app') });
      expect(ticks).toBeGreaterThan(5);
    } finally {
      process.env.PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
