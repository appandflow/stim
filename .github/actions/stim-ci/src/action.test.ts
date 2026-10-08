import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInputs, runAction } from './action.ts';

const github = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  output: vi.fn<(name: string, value: unknown) => void>(),
  warning: vi.fn<(message: string) => void>(),
  upload:
    vi.fn<
      (
        name: string,
        files: string[],
        rootDirectory: string,
        options?: { retentionDays?: number },
      ) => Promise<{ id?: number }>
    >(),
  tables: [] as string[][][],
}));
vi.mock('@actions/core', () => ({
  getInput: (name: string) => github.inputs[name] ?? '',
  setOutput: github.output,
  warning: github.warning,
  summary: {
    addHeading() {
      return this;
    },
    addTable(rows: string[][]) {
      github.tables.push(rows);
      return this;
    },
    async write() {},
  },
}));
vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: class {
    uploadArtifact = github.upload;
  },
}));

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ci-action-')));
  github.inputs = {
    platform: 'web',
    command: 'printf "%s" "$MESSAGE"',
    'cli-path': 'fixture.mjs',
    artifacts: 'results',
  };
  github.tables = [];
  github.output.mockReset();
  github.warning.mockReset();
  github.upload.mockReset().mockResolvedValue({ id: 123 });
  vi.stubEnv('GITHUB_WORKSPACE', root);
  vi.stubEnv('GITHUB_STEP_SUMMARY', '');
  vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
  vi.stubEnv('GITHUB_RUN_ID', '456');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('validates explicit inputs and preserves command source and argument paths', () => {
  github.inputs.home = 'home with spaces';
  github.inputs['build-cache'] = 'cache with spaces';
  github.inputs['upload-artifacts'] = 'false';
  const input = readInputs((name) => github.inputs[name] ?? '', root, 'linux');
  expect(input).toMatchObject({
    command: 'printf "%s" "$MESSAGE"',
    home: join(root, 'home with spaces'),
    cache: join(root, 'cache with spaces'),
    upload: false,
  });
  expect(() => readInputs((name) => github.inputs[name] ?? '', root, 'win32')).toThrow('macOS and Linux');
  for (const [name, value] of [
    ['platform', 'windows'],
    ['command', ' '],
    ['timeout', '0'],
    ['retention-days', '-1'],
    ['upload-artifacts', 'perhaps'],
  ]) {
    expect(() => readInputs((key) => (key === name ? value! : (github.inputs[key] ?? '')), root, 'linux')).toThrow(
      /required|must/,
    );
  }
  delete github.inputs['cli-path'];
  github.inputs.version = 'latest';
  expect(() => readInputs((name) => github.inputs[name] ?? '', root, 'linux')).toThrow('exact published version');
});

function fixture(exitCode: number, extra = '', stale = false): void {
  writeFileSync(
    join(root, 'fixture.mjs'),
    `
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const dir = value('--artifacts');
writeFileSync(join(dir, 'argv.json'), JSON.stringify(args));
writeFileSync(join(dir, 'test.stderr.log'), 'test evidence');
writeFileSync(join(dir, 'app.apk'), 'never upload');
const result = { version: 1, platform: value('--platform'), artifactsDir: dir, startedAt: ${stale ? "'2000-01-01T00:00:00Z'" : 'new Date().toISOString()'}, durationMs: 1, exitCode: ${exitCode} };
const save = () => writeFileSync(join(dir, 'result.json'), JSON.stringify(result));
${extra || 'save();'}
process.exitCode = ${exitCode};
`,
  );
}

test.skipIf(process.platform === 'win32')(
  'uploads failure evidence and preserves the original test exit code if transport fails',
  async () => {
    fixture(23);
    github.upload.mockRejectedValue(new Error('transport unavailable'));
    github.inputs.home = 'home with spaces';
    const code = await runAction();
    expect(code).toBe(23);
    const files = github.upload.mock.calls[0]![1];
    expect(files).toEqual([join(root, 'results/result.json'), join(root, 'results/test.stderr.log')]);
    const args = JSON.parse(readFileSync(join(root, 'results/argv.json'), 'utf8'));
    expect(args.slice(-7)).toEqual(['--', 'bash', '-e', '-o', 'pipefail', '-c', github.inputs.command]);
    expect(args).toContain(join(root, 'home with spaces'));
    expect(github.output).toHaveBeenCalledWith('result', join(root, 'results/result.json'));
  },
);

test.skipIf(process.platform === 'win32')(
  'returns a failure when requested upload fails after a passing run',
  async () => {
    fixture(0);
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(root, 'summary'));
    github.upload.mockRejectedValue(new Error('transport unavailable'));
    expect(await runAction()).toBe(1);
    expect(github.tables[0]).toContainEqual(['Exit code', '1']);
  },
);

test.skipIf(process.platform === 'win32')('publishes artifact ID and URL only after successful upload', async () => {
  fixture(0);
  expect(await runAction()).toBe(0);
  expect(github.output).toHaveBeenCalledWith('artifact-id', 123);
  expect(github.output).toHaveBeenCalledWith(
    'artifact-url',
    'https://github.com/owner/repo/actions/runs/456/artifacts/123',
  );
});

test.skipIf(process.platform === 'win32')(
  'keeps local paths and the original exit status when uploads are disabled',
  async () => {
    fixture(23);
    github.inputs['upload-artifacts'] = 'false';
    expect(await runAction()).toBe(23);
    expect(github.upload).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'results/result.json'))).toBe(true);
  },
);

test.skipIf(process.platform === 'win32')(
  'rejects old evidence before launch and refuses a stale result returned by a child',
  async () => {
    fixture(23);
    mkdirSync(join(root, 'results'));
    writeFileSync(join(root, 'results/result.json'), 'previous evidence');
    await expect(runAction()).rejects.toThrow('must be empty');
    expect(readFileSync(join(root, 'results/result.json'), 'utf8')).toBe('previous evidence');
    expect(existsSync(join(root, 'results/argv.json'))).toBe(false);
    rmSync(join(root, 'results'), { recursive: true });
    fixture(23, '', true);
    expect(await runAction()).toBe(23);
    expect(github.upload).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === 'win32')(
  'retains fresh partial test output when the child cannot save its result',
  async () => {
    fixture(1, '');
    const path = join(root, 'fixture.mjs');
    writeFileSync(path, readFileSync(path, 'utf8').replace('save();', ''));
    expect(await runAction()).toBe(1);
    expect(github.upload.mock.calls[0]![1]).toEqual([join(root, 'results/test.stderr.log')]);
  },
);

test.skipIf(process.platform === 'win32')(
  'forwards cancellation while allowing the child to finish cleanup and retain evidence',
  async () => {
    fixture(
      0,
      `
process.on('SIGTERM', () => { result.exitCode = 130; save(); process.exit(130); });
setInterval(() => {}, 1000);
writeFileSync(join(dir, 'ready'), 'ready');
`,
    );
    const running = runAction();
    const until = Date.now() + 2000;
    while (!existsSync(join(root, 'results/ready')) && Date.now() < until)
      await new Promise((done) => setTimeout(done, 10));
    expect(existsSync(join(root, 'results/ready'))).toBe(true);
    process.emit('SIGTERM');
    expect(await running).toBe(130);
    expect(JSON.parse(readFileSync(join(root, 'results/result.json'), 'utf8')).exitCode).toBe(130);
    expect(github.upload).toHaveBeenCalled();
  },
);
