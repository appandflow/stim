import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearNamedPorts, getNamedPort } from '../named-ports.ts';
import { getProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';

let home: string;
let root: string;
let server: ChildProcess | null = null;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-named-ports-it-')));
  root = join(home, 'project');
  mkdirSync(root);
  process.env.STIM_HOME = join(home, 'stim');
});

afterEach(() => {
  server?.kill('SIGKILL');
  server = null;
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('ports stop runs the recorded stop command, which ends a real listener, and releases only once the TCP table shows the port free', async () => {
  const script = join(home, 'stop.mjs');
  writeFileSync(
    script,
    [
      'const pid = Number(process.argv[2]);',
      "process.kill(pid, 'SIGTERM');",
      'for (;;) { try { process.kill(pid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 20)); }',
      "console.log('server stopped');",
    ].join('\n'),
  );
  const port = await getNamedPort(root, 'api');
  server = spawn(
    process.execPath,
    ['-e', `require('node:net').createServer().listen(${port}, '127.0.0.1', () => console.log('ready'))`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await once(server.stdout!, 'data');
  await getNamedPort(root, 'api', { commands: { stop: [process.execPath, script, String(server.pid)] } });

  await clearNamedPorts(root, { stop: true, log: () => {} });

  expect(getProject(root)?.ports).toEqual({});
  const events = readFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events).toContainEqual(
    expect.objectContaining({ event: 'port_stop', labels: ['api'], output: 'server stopped' }),
  );
});
