import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { cleanToolCache, planToolCaches, surveyToolCaches, type ToolCache } from '../stimd/passes/unowned.ts';

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
      runFileQuietAsync: async (file, args) =>
        file === 'ps'
          ? ps
          : file === 'lsof'
            ? `p${process.pid}\nn/\n`
            : file === 'npm' && args.join(' ') === 'config get cache'
              ? '/nonexistent/stim-test/.npm\n'
              : null,
      findExecutable: (name) => (name === 'npm' ? '/usr/local/bin/npm' : null),
    });
  });
  afterEach(() => resetExecutor());

  test('runs npm cache clean --force only when acting, on the cache npm reports', async () => {
    const [plan] = await surveyToolCaches();
    expect(plan?.cache.paths).toEqual(['/nonexistent/stim-test/.npm']);
    if (!plan) return;
    expect((await cleanToolCache(plan, false)).outcome).toBe('would');
    expect(calls.filter(([file]) => file === 'npm')).toEqual([]);
    expect((await cleanToolCache(plan, true)).outcome).toBe('done');
    expect(calls.filter(([file]) => file === 'npm')).toEqual([['npm', 'cache', 'clean', '--force']]);
  });

  test('keeps the cache when an install started after the plan', async () => {
    ps += '4242 npm install\n';
    const result = await cleanToolCache({ cache: npm, bytes: 1024, kept: null }, true);
    expect(result.outcome).toBe('kept');
    expect(calls).toEqual([]);
  });
});
