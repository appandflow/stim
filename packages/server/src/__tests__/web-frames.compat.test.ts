import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { buildFrameHelper } from '../frame-helper.ts';

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width">
<body style="margin:0"><button id="b" style="position:fixed;left:0;top:0;width:50vw;height:50vh"
onclick="window.taps=(window.taps||0)+1;this.textContent='tapped '+window.taps">tap</button>
<input id="i" style="position:fixed;left:0;top:60vh;width:90vw"></body>`;

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HELPER_DIR = fileURLToPath(new URL('../../helper/', import.meta.url));
const DESKTOP_DIR = fileURLToPath(new URL('../../../../apps/desktop/Sources/', import.meta.url));

interface Message {
  kind: number;
  keyframe?: boolean;
  width: number;
  height: number;
  notice?: string;
}

let home: string;
let server: Server;
let chrome: ChildProcess;
let endpoint: string;
let targetId: string;
const helpers: ChildProcess[] = [];

function sources(): string {
  const dir = join(home, 'sources');
  mkdirSync(dir);
  const desktop = readFileSync(join(HELPER_DIR, 'desktop-sources.txt'), 'utf8').split(/\s+/).filter(Boolean);
  for (const source of [
    join(HELPER_DIR, 'main.swift'),
    join(HELPER_DIR, 'VideoEncoder.swift'),
    join(HELPER_DIR, 'PhoneSource.swift'),
    join(HELPER_DIR, 'FrameArtwork.swift'),
    ...desktop.map((path) => join(DESKTOP_DIR, path)),
  ]) {
    copyFileSync(source, join(dir, basename(source)));
  }
  return dir;
}

function run(
  helper: string,
  pid: number,
): { messages: Message[]; child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn(helper, ['web', endpoint, String(pid), targetId], { stdio: ['pipe', 'pipe', 'inherit'] });
  helpers.push(child);
  const messages: Message[] = [];
  let buffer = Buffer.alloc(0);
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const body = buffer.subarray(4, 4 + buffer.readUInt32BE(0));
      buffer = buffer.subarray(4 + body.length);
      if (body[0] === 1) messages.push({ kind: 1, width: body.readUInt16BE(1), height: body.readUInt16BE(3) });
      if (body[0] === 2) messages.push({ kind: 2, width: 0, height: 0, notice: body.subarray(1).toString() });
      if (body[0] === 3) {
        messages.push({
          kind: 3,
          keyframe: (body[1]! & 1) === 1,
          width: body.readUInt16BE(10),
          height: body.readUInt16BE(12),
        });
      }
    }
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { messages, child, exited };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function evaluate(expression: string): Promise<unknown> {
  const socket = new WebSocket(`${endpoint.replace('http', 'ws')}/devtools/page/${targetId}`);
  await new Promise((resolve) => socket.once('open', resolve));
  const reply = new Promise<{ result: { result: { value: unknown } } }>((resolve) =>
    socket.once('message', (data) => resolve(JSON.parse(String(data)))),
  );
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  const value = (await reply).result.result.value;
  socket.close();
  return value;
}

beforeAll(async () => {
  assert(existsSync(CHROME), 'Google Chrome is not installed; the web frames compatibility stage needs it.');
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-web-frames-')));
  process.env.STIM_HOME = join(home, 'stim');
  server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const profile = join(home, 'profile');
  chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--headless',
      '--window-size=800,600',
      '--no-first-run',
      '--password-store=basic',
      '--use-mock-keychain',
      `http://127.0.0.1:${address.port}/`,
    ],
    { stdio: 'ignore' },
  );
  await until(() => existsSync(join(profile, 'DevToolsActivePort')), 20_000);
  const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  endpoint = `http://127.0.0.1:${port}`;
  let pages: { id: string; type: string; url: string }[] = [];
  await until(() => {
    void fetch(`${endpoint}/json/list`)
      .then((response) => response.json())
      .then((list) => (pages = list as typeof pages))
      .catch(() => {});
    return pages.some((page) => page.type === 'page' && page.url.startsWith('http://127.0.0.1'));
  });
  targetId = pages.find((page) => page.type === 'page')!.id;
}, 60_000);

afterAll(async () => {
  for (const helper of helpers) helper.kill('SIGKILL');
  chrome?.kill('SIGKILL');
  await new Promise((resolve) => server?.close(resolve));
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('stim-frames streams H.264 and JPEG from real Chrome, types and taps, and refuses another browser', async () => {
  const helper = await buildFrameHelper(process.env, undefined, sources());

  const video = run(helper, chrome.pid!);
  video.child.stdin!.write('{"fps":30,"maxEdge":1280,"jpeg":false,"video":true}\n');
  await until(() => video.messages.some((message) => message.kind === 3 && message.keyframe));
  const first = video.messages.find((message) => message.kind === 3)!;
  expect(first).toMatchObject({ keyframe: true, width: 800 });
  expect(first.height).toBeGreaterThan(400);

  const units = video.messages.length;
  video.child.stdin!.write('{"keyframe":true}\n');
  await until(() => video.messages.slice(units).some((message) => message.kind === 3 && message.keyframe));

  const beforeTap = video.messages.length;
  video.child.stdin!.write(
    '{"input":"touch","phase":"down","x":0.25,"y":0.25}\n{"input":"touch","phase":"up","x":0.25,"y":0.25}\n',
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await evaluate('window.taps')).toBe(1);
  await until(() => video.messages.slice(beforeTap).some((message) => message.kind === 3));
  await evaluate('document.getElementById("i").focus()');
  video.child.stdin!.write('{"input":"text","text":"Stim wa\\beb\\n"}\n');
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await evaluate('document.getElementById("i").value')).toBe('Stim web');
  video.child.stdin!.end();
  expect(await video.exited).toBe(0);

  const jpeg = run(helper, chrome.pid!);
  jpeg.child.stdin!.write('{"fps":5,"maxEdge":400,"jpeg":true,"video":false}\n');
  await until(() => jpeg.messages.some((message) => message.kind === 1));
  expect(jpeg.messages.find((message) => message.kind === 1)).toMatchObject({ width: 400 });
  jpeg.child.stdin!.end();

  const refused = run(helper, 1);
  expect(await refused.exited).toBe(1);
  expect(refused.messages.find((message) => message.kind === 2)?.notice).toMatch(/not the owned Chrome 1\b/);
}, 240_000);
