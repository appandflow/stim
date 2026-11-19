import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const writer = vi.hoisted(() => ({ syncDelayMs: 0 }));

vi.mock('../stimd/logs/writer.ts', async (original) => {
  const actual = await original<typeof import('../stimd/logs/writer.ts')>();
  return {
    ...actual,
    createLogWriters: (...args: Parameters<typeof actual.createLogWriters>) => {
      const writers = actual.createLogWriters(...args);
      return {
        ...writers,
        open: async (...input: Parameters<typeof writers.open>) => {
          const sink = await writers.open(...input);
          return {
            ...sink,
            sync: async () => {
              await new Promise((done) => setTimeout(done, writer.syncDelayMs));
              return sink.sync();
            },
          };
        },
      };
    },
  };
});

describe.skipIf(process.platform === 'win32')('readiness coverage behind a slow log writer', () => {
  test('stimd proves coverage within the wait budget it is given, not within one poll', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-sync-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-sync-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    writeFileSync(join(bin, 'xcrun'), '#!/bin/sh\ncase "$*" in *"log show"*) exit 0;; *) exec sleep 600;; esac\n');
    chmodSync(join(bin, 'xcrun'), 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      const since = Date.now();
      const signal = new AbortController().signal;
      const ask = (after: number, timeoutMs: number, through: number) =>
        streams.wait(root, 'ios', 'default', streamId, since, after, timeoutMs, signal, env, through, true);
      let reply = await ask(0, 1000, since);
      while (reply.coverage === 'pending') reply = await ask(reply.revision, 1000, since);
      expect(reply.coverage).toBe('covered');
      writer.syncDelayMs = 650;
      expect((await ask(reply.revision, 500, since)).coverage).toBe('pending');
      expect((await ask(reply.revision, 2000, since)).coverage).toBe('covered');
    } finally {
      writer.syncDelayMs = 0;
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
