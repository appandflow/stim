import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trashRoot } from '@stim-cli/core/state';
import { runCli } from '../cli/define-op.ts';
import { doctorOp } from '../commands/doctor.ts';
import { analyzeStimVersions } from '../diagnostics/stim-installations.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { getProject } from '../workspace/config.ts';
import { hungRead, pendingRead } from '../workspace/bounded-read.ts';
import { TRASH_MANIFEST } from '../workspace/worktree-trash.ts';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn<typeof fs.readFile>(fs.readFile) };
});

describe.skipIf(process.platform === 'win32')('doctor with pending native storage IO', () => {
  test.each([false, true])(
    'doctor records and renders before exiting with a real native read still pending: json=%s',
    async (json) => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-doctor-blocked-trash-')));
      const project = join(base, 'app');
      mkdirSync(project);
      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify({ name: 'app', dependencies: { 'react-native': '*' } }),
      );
      vi.stubEnv('STIM_HOME', join(base, 'home'));
      vi.stubEnv('STIM_DAEMON', 'off');
      const dir = join(trashRoot(), 'item-blocked');
      mkdirSync(join(dir, 'entries', 'payload'), { recursive: true });
      const manifest = join(dir, TRASH_MANIFEST);
      writeFileSync(
        manifest,
        JSON.stringify({
          kind: 'gc-item',
          createdAt: new Date().toISOString(),
          source: { kind: 'cache', id: '/selected' },
          bytes: 1,
        }),
      );
      const fifo = join(base, 'pending-storage-read');
      execFileSync('mkfifo', [fifo]);
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let nativeRead: Promise<string> | undefined;
      let nativeSettled = false;
      const settled = () => {
        nativeSettled = true;
      };
      vi.mocked(readFile).mockImplementation((...args) => {
        if (String(args[0]) !== manifest) return actual.readFile(...args);
        nativeRead = actual.readFile(fifo, 'utf8');
        void nativeRead.then(settled, settled);
        return nativeRead;
      });
      setExecutor({
        ...getExecutor(),
        runFileQuiet: () => null,
        runFileQuietAsync: async () => null,
      });
      const logs: string[] = [];
      const output = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        logs.push(String(line));
      });
      const cwd = process.cwd();
      const exitCode = process.exitCode;
      process.exitCode = 7;
      process.chdir(project);
      try {
        const versions = analyzeStimVersions('1.2.3', '/tools/stim-cli', []);
        const result = await runCli(
          doctorOp(() => versions, 'linux'),
          [...(json ? ['--json'] : []), '--platform', 'ios'],
          { version: '1.2.3' },
        );
        expect(result).toBe(0);
        expect(process.exitCode).toBe(7);
        expect(hungRead()).toBe(dir);
        const rendered = json ? JSON.parse(logs[0] ?? '{}').project : logs[0];
        expect(rendered).toContain(json ? project : 'Doctor (iOS)');
        expect(getProject(project)?.doctorRuns?.ios?.version).toBe('1.2.3');
      } finally {
        process.chdir(cwd);
        process.exitCode = exitCode;
        output.mockRestore();
        if (nativeRead && !nativeSettled) writeFileSync(fifo, '{}');
        await nativeRead?.catch(() => undefined);
        await pendingRead();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        resetExecutor();
        rmSync(base, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
