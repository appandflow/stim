import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import * as processIdentity from '@stim-cli/core/process-identity';
import { HelperSource } from '../src/frame-helper.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-frame-helper-exited-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')(
  'a capture helper that exits before its identity is read fails with its own exit detail',
  async () => {
    const helper = join(home, 'helper');
    writeFileSync(helper, `#!${process.execPath}\nprocess.stderr.write('helper broke\\n');process.exit(4);\n`);
    chmodSync(helper, 0o755);
    const claim = tryAcquireClaim({ root: join(home, 'frames.claims'), mode: 'exclusive' }).acquired;
    if (!claim) throw new Error('The test claim was not acquired.');
    const capture = processIdentity.captureProcessIdentity;
    vi.spyOn(processIdentity, 'captureProcessIdentity').mockImplementation((pid) => {
      if (pid !== process.pid) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return capture(pid);
    });
    const failed = new Promise<string>((resolve) => {
      const source = new HelperSource(
        helper,
        { platform: 'ios', udid: 'UDID', foldable: false },
        process.env,
        () => {},
        1000,
        undefined,
        claim,
      );
      source.add({ frame: () => {}, delayed: () => {}, failed: resolve }, null);
    });
    try {
      expect(await failed).toMatch(/^stim-frames exited \(code 4\): helper broke/);
    } finally {
      releaseClaim(claim);
    }
  },
);
