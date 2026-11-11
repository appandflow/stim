import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { cleanToolCache, planToolCaches, type ToolCache } from '../stimd/passes/unowned.ts';

const npm: ToolCache = {
  tool: 'npm',
  label: 'npm cache',
  paths: ['/nonexistent/stim-test/.npm'],
  command: ['npm', 'cache', 'clean', '--force'],
  running: /(^|[\s/])(npm|npx)(\s|$)|npm-cli\.js/,
};

test.each([
  { name: 'a running install keeps its cache', lines: ['/usr/local/bin/node /usr/lib/npm-cli.js install'], kept: true },
  { name: 'unrelated processes do not', lines: ['/bin/zsh', '/usr/local/bin/node server.js'], kept: false },
  { name: 'processes that cannot be listed keep it', lines: null, kept: true },
])('$name', ({ lines, kept }) => {
  const [plan] = planToolCaches([npm], lines, new Map([[npm, 1024]]));
  expect(plan?.kept !== null).toBe(kept);
});

describe('cleaning a tool cache', () => {
  const calls: string[][] = [];
  let ps = '';
  beforeEach(() => {
    calls.length = 0;
    ps = `${process.pid} node vitest\n`;
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args) => {
        calls.push([file, ...args]);
        return '';
      },
      runFileQuietAsync: async (file) => (file === 'ps' ? ps : file === 'lsof' ? `p${process.pid}\nn/\n` : null),
    });
  });
  afterEach(() => resetExecutor());

  test('runs the tool command itself and nothing on a dry run', async () => {
    const plan = { cache: npm, bytes: 1024, kept: null };
    expect((await cleanToolCache(plan, false)).outcome).toBe('would');
    expect(calls).toEqual([]);
    const result = await cleanToolCache(plan, true);
    expect(result.outcome).toBe('done');
    expect(calls).toEqual([['npm', 'cache', 'clean', '--force']]);
  });

  test('keeps the cache when an install started after the plan', async () => {
    ps += '4242 npm install\n';
    const result = await cleanToolCache({ cache: npm, bytes: 1024, kept: null }, true);
    expect(result.outcome).toBe('kept');
    expect(calls).toEqual([]);
  });
});
