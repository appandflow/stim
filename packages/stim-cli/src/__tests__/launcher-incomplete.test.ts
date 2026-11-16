import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launcherFindings } from '../diagnostics/launcher-evidence.ts';
import { launchersOf, logLauncherProblems } from '../workspace/launchers.ts';
import { testContext } from './_context.ts';

const launcherDirs = vi.hoisted(() => ({ list: new Array<string>() }));
vi.mock('../workspace/launcher-directories.ts', () => ({ launcherDirectories: () => launcherDirs.list }));

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'launcher evidence that cannot be settled is reported, not only kept',
  () => {
    let base: string;
    let locked: string;

    beforeEach(() => {
      base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-launcher-incomplete-')));
      locked = join(base, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      launcherDirs.list = [locked];
    });

    afterEach(() => {
      chmodSync(locked, 0o755);
      rmSync(base, { recursive: true, force: true });
    });

    it('is a doctor finding with a code, the directory, the error and the fix, and none once it can be read', async () => {
      const [found, ...rest] = await launcherFindings({});
      expect(rest).toEqual([]);
      expect(found).toMatchObject({
        code: 'launcher-evidence-incomplete',
        level: 'cost',
        detail: expect.stringContaining(`the directory ${locked} could not be read (EACCES)`),
        fix: expect.stringContaining('fix its permissions'),
      });
      expect(found?.detail).toContain('keep every checkout');

      chmodSync(locked, 0o755);
      expect(await launcherFindings({})).toEqual([]);
    });

    it('is one log record per pass naming the cause, however many readings met it', async () => {
      const operation = testContext();
      await launchersOf(operation)();
      await launchersOf(operation)();
      const log = vi.fn<(level: string, event: string, msg: string, fields?: unknown) => void>();
      logLauncherProblems(operation, log);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        'warn',
        'launcher_evidence_incomplete',
        expect.stringContaining(`the directory ${locked} could not be read (EACCES)`),
        expect.anything(),
      );

      logLauncherProblems(operation, log);
      expect(log).toHaveBeenCalledTimes(1);
    });
  },
);

describe('the doctor read of the launcher directories', () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-launcher-budget-')));
    mkdirSync(join(base, 'bin'));
    writeFileSync(join(base, 'real'), 'x');
    for (let index = 0; index < 50; index++) symlinkSync(join(base, 'real'), join(base, 'bin', `tool-${index}`));
    launcherDirs.list = [join(base, 'bin')];
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('reports incomplete evidence, never a complete result, when the budget ends the read mid-scan', async () => {
    const budget = new AbortController();
    const reading = launcherFindings({}, budget.signal);
    budget.abort();
    const [found] = await reading;
    expect(found).toMatchObject({
      code: 'launcher-evidence-incomplete',
      detail: expect.stringContaining('did not finish'),
    });
  });

  it('reports nothing when the whole read finishes within the budget', async () => {
    expect(await launcherFindings({}, new AbortController().signal)).toEqual([]);
  });
});
