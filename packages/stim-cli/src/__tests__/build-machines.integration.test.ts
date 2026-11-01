import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyFingerprint } from '@stim-cli/core/noise-session';
import { buildMachinesFile, readBuildMachines } from '@stim-cli/core/state';
import { resetExecutor, setExecutor } from '../exec.ts';
import { inspectBuildMachines, resolveEndpoint, type Endpoint } from '../offload/build-machines.ts';
import { keyConfirmer, realIo, type HelloReply, type MachineAuth, type TailnetMachineIo } from '../offload/tailnet.ts';
import { startProtocol1Server } from './_noise-server.ts';
import { createServer, type Server } from 'node:http';
import { getConfigPath } from '../workspace/config.ts';

function listenPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server is not listening');
  return address.port;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-build-machines-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_ACCESS_TICKET', undefined);
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const SERVER_KEY = 'S'.repeat(42) + 'A';
const OTHER_KEY = 'O'.repeat(42) + 'A';
const DESKTOP_TICKET = 'd'.repeat(42) + 'A';

function status(os = 'macOS', dnsName = 'mini.tail1.ts.net.') {
  return {
    BackendState: 'Running',
    Self: { ID: 'nLaptop', HostName: 'lap‍top', DNSName: 'laptop.tail1.ts.net.' },
    Peer: {
      key1: { ID: 'nMini', DNSName: dnsName, TailscaleIPs: ['fd7a::1', '100.64.0.7'], OS: os },
      key2: { ID: 'nFunnel', DNSName: '' },
      key3: { ID: 'nOther', DNSName: 'minimal.tail1.ts.net.', TailscaleIPs: ['100.64.0.8'] },
    },
  };
}

function fakeIo(replies: HelloReply[], os = 'macOS') {
  const calls: { endpoint: Endpoint; auth: MachineAuth }[] = [];
  const io = {
    status: () => status(os),
    hello: (endpoint: Endpoint, auth: MachineAuth) => {
      calls.push({
        endpoint,
        auth: 'ticket' in auth ? { access: auth.access, ticket: auth.ticket, name: auth.name } : auth,
      });
      return Promise.resolve(replies.shift() ?? { failed: 'no reply scripted' });
    },
  };
  return { io, calls };
}

const notYet: HelloReply = { error: { code: 'unknown-secret', message: 'The machine does not know this ticket yet.' } };
const approved = (host?: { name: string; screenRecording: boolean; accessibility: boolean }): HelloReply => ({
  result: { capabilities: ['build'], device: { id: 'ab12', name: 'laptop' }, ...(host ? { host } : {}) },
  serverKey: SERVER_KEY,
});
const refused: HelloReply = { error: { code: 'unauthorized', message: 'Pair again.' } };

/** Asks with --fix while the worker has not run setup, leaving a pending credential with a generated ticket. */
async function askedPending() {
  return inspectBuildMachines({ fix: true, version: '9.9.9' }, fakeIo([notYet]).io, ['mini']);
}

async function approvedCredential() {
  await askedPending();
  await inspectBuildMachines({ fix: false }, fakeIo([approved()]).io, ['mini']);
}

test('resolveEndpoint reads tailscale status without blocking the event loop, falling back to the Mac app binary', async () => {
  const asked: string[] = [];
  setExecutor({
    runFile: () => {
      throw new Error('runFile must not be used');
    },
    runFileQuiet: () => {
      throw new Error('runFileQuiet blocks the event loop');
    },
    runFileAsync: async (file: string) => {
      asked.push(file);
      if (file === 'tailscale') throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
      return JSON.stringify(status());
    },
  });
  expect(await resolveEndpoint({ machine: 'mini' })).toEqual({
    url: 'wss://100.64.0.7:7443',
    servername: 'mini.tail1.ts.net',
    host: 'mini.tail1.ts.net:7443',
  });
  expect(asked).toEqual(['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
});

describe('the tailnet a machine was approved on', () => {
  const home1 = { name: 'janic@example.com', suffix: 'tail1.ts.net', id: 'TID1' };
  const work = { name: 'work.example.com', suffix: 'tail9.ts.net', id: 'TID9' };
  const on = (tailnet: typeof home1, peers = true) => ({
    ...status(),
    CurrentTailnet: { Name: tailnet.name, MagicDNSSuffix: tailnet.suffix, StableID: tailnet.id },
    ...(peers ? {} : { Peer: {} }),
  });
  const ioOn = (tailnet: typeof home1, replies: HelloReply[], peers = true) => ({
    ...fakeIo(replies).io,
    status: () => on(tailnet, peers),
  });

  it('reports a machine missing from another tailnet by naming both, and leaves an old pin on the generic message', async () => {
    await inspectBuildMachines({ fix: true, version: '9.9.9' }, ioOn(home1, [notYet]), ['mini']);
    const { machines, findings } = await inspectBuildMachines({ fix: false }, ioOn(work, [], false), ['mini']);
    const diagnosis = machines[0]?.diagnosis;
    expect(machines[0]).toMatchObject({
      state: 'not-on-tailnet',
      tailnet: home1,
      diagnosis: { code: 'peer-wrong-tailnet' },
    });
    expect(diagnosis?.message).toContain('janic@example.com (tail1.ts.net)');
    expect(diagnosis?.message).toContain('work.example.com (tail9.ts.net)');
    expect(diagnosis?.remedy).toContain('Switch Tailscale on this Mac to janic@example.com');
    expect(findings[0]?.fix).toBe(diagnosis?.remedy);

    const old = fakeIo([]).io;
    rmSync(buildMachinesFile());
    await approvedCredential();
    const generic = await inspectBuildMachines({ fix: false }, { ...old, status: () => on(work, false) }, ['mini']);
    expect(generic.machines[0]).toMatchObject({ diagnosis: { code: 'peer-not-found' } });
  });

  it('keeps a node shared in from another tailnet reachable, and names its owner when the Mac is on a third', async () => {
    const shared = { machine: 'mini2', address: 'mini2.tail7.ts.net', tailnet: home1 };
    const sharedIn = {
      ...on(home1),
      Peer: { k: { ID: 'nS', DNSName: 'mini2.tail7.ts.net.', TailscaleIPs: ['100.64.0.9'] } },
    };
    expect(await resolveEndpoint(shared, () => sharedIn)).toMatchObject({ servername: 'mini2.tail7.ts.net' });
    expect(await resolveEndpoint(shared, () => on(work, false))).toContain(
      'or to tail7.ts.net, the tailnet that owns mini2',
    );
  });
});

describe('inspectBuildMachines', () => {
  it('plain doctor never asks a machine it holds no credential for', async () => {
    const { io, calls } = fakeIo([]);
    const { machines } = await inspectBuildMachines({ fix: false }, io, ['mini', 'nope', 'bad;name']);
    expect(machines).toEqual([
      { machine: 'mini', state: 'not-asked', dnsName: 'mini.tail1.ts.net' },
      { machine: 'nope', state: 'not-on-tailnet', diagnosis: expect.objectContaining({ code: 'peer-not-found' }) },
      { machine: 'bad;name', state: 'invalid' },
    ]);
    expect(calls).toEqual([]);
  });

  it('saves the server key the ticket authenticated before hello, and resumes with it after a lost reply', async () => {
    await askedPending();
    const ticket = readBuildMachines()[0]!.ticket!;
    const lost = fakeIo([]);
    lost.io.hello = async (_endpoint, auth) => {
      if ('onServerKey' in auth) await auth.onServerKey?.(SERVER_KEY);
      return { failed: 'the connection closed before a hello result' };
    };
    expect((await inspectBuildMachines({ fix: false }, lost.io, ['mini'])).machines[0]!.state).toBe('unreachable');
    expect(readBuildMachines()[0]).toMatchObject({ state: 'pending', ticket, serverKey: SERVER_KEY });
    const { io, calls } = fakeIo([approved()]);
    expect((await inspectBuildMachines({ fix: false }, io, ['mini'])).machines[0]!.state).toBe('approved');
    expect(calls.map((call) => call.auth)).toEqual([{ access: 'build', serverKey: SERVER_KEY }]);
  });

  it('connects an approved machine only with its pinned key, and keeps the pin when another key answers', async () => {
    await approvedCredential();
    const { io, calls } = fakeIo([{ error: { code: 'server-key-mismatch', message: 'another key' } }]);
    const { findings, machines } = await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(calls.map((call) => call.auth)).toEqual([{ access: 'build', serverKey: SERVER_KEY }]);
    expect(machines).toEqual([expect.objectContaining({ state: 'key-changed' })]);
    expect(findings[0]!.title).toBe('Remote machine mini answered with a different server key');
    expect(readBuildMachines()[0]!.serverKey).toBe(SERVER_KEY);
  });

  describe('a machine on the local network', () => {
    const LAN = 'local:10.0.0.92';
    const noTailscale = (
      replies: HelloReply[],
      readStatus: () => unknown = () => {
        throw new Error('a local network machine must not read tailscale status');
      },
    ) => {
      const fake = fakeIo(replies);
      const io: TailnetMachineIo = { ...fake.io, status: readStatus };
      return { io, calls: fake.calls };
    };
    const firstContact = (replies: HelloReply[]) => {
      const fake = noTailscale(replies);
      const hello = fake.io.hello;
      fake.io.hello = async (endpoint, auth) => {
        if ('onServerKey' in auth) await auth.onServerKey?.(SERVER_KEY);
        return hello(endpoint, auth);
      };
      return fake;
    };
    const confirming = (answer: boolean) => {
      const asked: [string, string][] = [];
      return {
        asked,
        confirmKey: async (machine: string, key: string) => {
          asked.push([machine, key]);
          return answer;
        },
      };
    };

    it('never pins the key its ticket authenticated until a person confirms the fingerprint', async () => {
      await inspectBuildMachines({ fix: true, version: '9.9.9' }, noTailscale([notYet]).io, [LAN]);
      const declined = confirming(false);
      const { findings, machines } = await inspectBuildMachines(
        { fix: true, confirmKey: declined.confirmKey },
        firstContact([approved()]).io,
        [LAN],
      );
      expect(declined.asked).toEqual([[LAN, SERVER_KEY]]);
      expect(machines).toEqual([
        expect.objectContaining({ state: 'key-unconfirmed', fingerprint: expect.any(String) }),
      ]);
      expect(findings[0]?.detail).toContain(machines[0]?.fingerprint);
      expect(readBuildMachines()[0]).toMatchObject({ state: 'pending' });
      expect(readBuildMachines()[0]).not.toHaveProperty('serverKey');

      const accepted = confirming(true);
      const later = await inspectBuildMachines(
        { fix: true, confirmKey: accepted.confirmKey },
        firstContact([approved()]).io,
        [LAN],
      );
      expect(later.machines).toEqual([expect.objectContaining({ state: 'approved' })]);
      expect(readBuildMachines()[0]).toMatchObject({ state: 'approved', serverKey: SERVER_KEY });

      const { io, calls } = noTailscale([approved()]);
      await inspectBuildMachines({ fix: false, confirmKey: confirming(false).confirmKey }, io, [LAN]);
      expect(calls.map((call) => call.auth)).toEqual([{ access: 'build', serverKey: SERVER_KEY }]);
    });

    it('asks a person once per machine and key, one question at a time, and answers no without a terminal', async () => {
      const questions: string[] = [];
      let open = 0;
      let most = 0;
      const confirm = keyConfirmer(async (question) => {
        questions.push(question);
        most = Math.max(most, ++open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open--;
        return true;
      });
      expect(await Promise.all([confirm(LAN, SERVER_KEY), confirm(LAN, SERVER_KEY), confirm(LAN, OTHER_KEY)])).toEqual([
        true,
        true,
        true,
      ]);
      expect(questions).toHaveLength(2);
      expect(most).toBe(1);
      expect(questions[0]).toContain(keyFingerprint(Buffer.from(SERVER_KEY, 'base64url')));
      expect(await keyConfirmer(null)(LAN, SERVER_KEY)).toBe(false);
    });

    it('still reaches a local machine while Tailscale is off for the tailnet ones', async () => {
      let read = 0;
      const { io } = noTailscale([notYet], () => {
        read++;
        return null;
      });
      const { machines } = await inspectBuildMachines({ fix: true, version: '9.9.9' }, io, ['mini', LAN]);
      expect(read).toBe(1);
      expect(machines).toEqual([
        expect.objectContaining({ machine: 'mini', state: 'tailscale-off' }),
        expect.objectContaining({ machine: LAN, state: 'pending' }),
      ]);
    });
  });

  describe('a worker that still runs a protocol 1 stim-server', () => {
    let old: Awaited<ReturnType<typeof startProtocol1Server>>;
    beforeEach(async () => {
      old = await startProtocol1Server();
    });
    afterEach(() => old.close());
    const io = () => ({
      status: () => status(),
      hello: (_endpoint: Endpoint, auth: MachineAuth) =>
        realIo.hello({ url: `ws://127.0.0.1:${old.port}`, servername: 'mini', host: `127.0.0.1:${old.port}` }, auth),
    });

    it('reports an approved machine outdated without a setup command, and keeps its pinned key', async () => {
      await approvedCredential();
      const before = readBuildMachines();
      const { findings, machines } = await inspectBuildMachines({ fix: true, version: '9.9.9' }, io(), ['mini']);
      expect(machines).toEqual([expect.objectContaining({ state: 'outdated' })]);
      expect(findings).toEqual([
        expect.objectContaining({
          fix: expect.stringMatching(
            /^On mini, run `stim-server service update --release 9\.9\.9` \(add `--label <name>` for a custom service label; .*\), then run `stim remote add mini` here\.$/,
          ),
        }),
      ]);
      expect(readBuildMachines()).toEqual(before);
    });
  });

  describe('naming the layer an unreachable machine stopped at', () => {
    let upstream: Server;
    let upstreamPort: number;
    let upstreamStatus = 502;
    beforeEach(async () => {
      upstream = createServer((_request, response) => response.writeHead(426).end());
      upstream.on('upgrade', (_request, socket) => {
        socket.end(`HTTP/1.1 ${upstreamStatus} Nope\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      });
      await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
      upstreamPort = listenPort(upstream);
    });
    afterEach(() => new Promise<void>((done) => upstream.close(() => done())));

    const realConnection = (extra: Record<string, unknown> = {}) => ({
      status: () => status(),
      hello: (_endpoint: Endpoint, auth: MachineAuth) =>
        realIo.hello(
          { url: `ws://127.0.0.1:${upstreamPort}`, servername: 'mini', host: `127.0.0.1:${upstreamPort}` },
          auth,
        ),
      ...extra,
    });

    it('says stim-server is not running when the serve route answers 502', async () => {
      await approvedCredential();
      upstreamStatus = 502;
      const { findings, machines } = await inspectBuildMachines({ fix: false }, realConnection(), ['mini']);
      expect(machines).toEqual([
        expect.objectContaining({
          state: 'unreachable',
          diagnosis: expect.objectContaining({ layer: 'server', code: 'server-not-running' }),
        }),
      ]);
      expect(findings).toHaveLength(1);
    });

    it('still names a 503 from a stim-server whose /health says nothing', async () => {
      await approvedCredential();
      upstreamStatus = 503;
      const { machines } = await inspectBuildMachines({ fix: false }, realConnection({ startup: async () => null }), [
        'mini',
      ]);
      expect(machines).toEqual([
        expect.objectContaining({ diagnosis: expect.objectContaining({ code: 'server-not-ready' }) }),
      ]);
    });
  });

  it('reports a revoked machine, and --fix makes a new ticket for it', async () => {
    await approvedCredential();
    const revoked = await inspectBuildMachines({ fix: false }, fakeIo([refused]).io, ['mini']);
    expect(revoked.machines).toEqual([expect.objectContaining({ state: 'revoked', deviceId: 'ab12' })]);
    expect(readBuildMachines()[0]!.state).toBe('approved');
    const { io, calls } = fakeIo([refused, notYet]);
    const asked = await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(asked.machines).toEqual([expect.objectContaining({ state: 'pending' })]);
    expect(calls[1]!.auth).toMatchObject({ access: 'build', ticket: readBuildMachines()[0]!.ticket });
  });

  it('reports a generated ticket past its expiry as lapsed without contacting the machine, and --fix makes a new one', async () => {
    await askedPending();
    const file = buildMachinesFile();
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { machines: Record<string, unknown>[] };
    const old = stored.machines[0]!.ticket;
    stored.machines[0]!.expiresAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(file, JSON.stringify(stored));
    const { io, calls } = fakeIo([]);
    const { machines, findings } = await inspectBuildMachines({ fix: false }, io, ['mini']);
    expect(machines).toEqual([expect.objectContaining({ state: 'lapsed' })]);
    expect(findings[0]!.fix).toContain('stim remote add mini');
    expect(calls).toEqual([]);
    await inspectBuildMachines({ fix: true }, fakeIo([notYet]).io, ['mini']);
    expect(readBuildMachines()[0]!.ticket).not.toBe(old);
  });

  it('an approved credential ignores a new Desktop ticket', async () => {
    await approvedCredential();
    vi.stubEnv('STIM_ACCESS_TICKET', DESKTOP_TICKET);
    const { io, calls } = fakeIo([approved()]);
    await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(calls.map((call) => call.auth)).toEqual([{ access: 'build', serverKey: SERVER_KEY }]);
  });

  it('reports every reason an approved machine would not take the build, with a remedy for each', async () => {
    await approvedCredential();
    const host = { name: 'Stim Host', screenRecording: true, accessibility: false };
    const checked: (string | undefined)[] = [];
    const { findings, machines } = await inspectBuildMachines(
      {
        fix: false,
        check: (credential) => {
          checked.push(credential.serverKey);
          return Promise.resolve({
            capacity: { running: 0, max: 1, loadPerCore: 8.2, builds: 2 },
            problems: [
              { code: 'stim-build', reason: 'Stim build 6bbe there, e774 here' },
              { code: 'busy', reason: 'busy (load at or above 2/core; load 8.2/core, 2 builds)' },
            ],
          });
        },
      },
      fakeIo([approved(host)]).io,
      ['mini'],
    );
    expect(checked).toEqual([SERVER_KEY]);
    expect(machines).toEqual([
      expect.objectContaining({
        state: 'approved',
        host,
        offloadable: false,
        reasons: ['Stim build 6bbe there, e774 here', 'busy (load at or above 2/core; load 8.2/core, 2 builds)'],
        capacity: { running: 0, max: 1, loadPerCore: 8.2, builds: 2 },
      }),
    ]);
    expect(findings.map(({ code, level }) => ({ code, level }))).toEqual([
      { code: 'build-machine-stim-build', level: 'cost' },
      { code: 'build-machine-busy', level: 'note' },
    ]);
    expect(findings[0]!.fix).toContain('run `stim-server service update --release <version>`');
  });

  it('reports a package Gradle downloads as a note that does not stop the build, and a blocker with commands otherwise', async () => {
    await approvedCredential();
    const note = {
      code: 'ndk' as const,
      reason: 'NDK 27.1.12297006 is not installed there; Gradle downloads it on the first build (about 1-2 GB)',
      lead: 'install the package now so the first build does not download it',
      commands: ['/sdk/cmdline-tools/latest/bin/sdkmanager "ndk;27.1.12297006"'],
    };
    const blocker = {
      code: 'build-tools' as const,
      reason: 'no build-tools 37.0.0 there, and its SDK licenses are not accepted',
      lead: 'accept the SDK licenses so Gradle downloads the package, or install it',
      commands: [
        '/sdk/cmdline-tools/latest/bin/sdkmanager --licenses',
        '/sdk/cmdline-tools/latest/bin/sdkmanager "build-tools;37.0.0"',
      ],
    };
    const run = (problems: (typeof blocker)[], notes: (typeof note)[]) =>
      inspectBuildMachines(
        { fix: false, check: () => Promise.resolve({ capacity: null, problems, notes }) },
        fakeIo([approved()]).io,
        ['mini'],
      );
    const taken = await run([], [note]);
    expect(taken.machines).toEqual([expect.objectContaining({ offloadable: true, reasons: [], notes: [note] })]);
    expect(taken.findings).toEqual([
      expect.objectContaining({
        code: 'build-machine-ndk',
        level: 'note',
        detail: `The build goes there anyway: ${note.reason}.`,
        fix: ['On mini, install the package now so the first build does not download it:', ...note.commands].join('\n'),
      }),
    ]);
    const blocked = await run([blocker], []);
    expect(blocked.machines).toEqual([expect.objectContaining({ offloadable: false, reasons: [blocker.reason] })]);
    expect(blocked.findings).toEqual([
      expect.objectContaining({
        code: 'build-machine-build-tools',
        level: 'cost',
        fix: [
          'On mini, accept the SDK licenses so Gradle downloads the package, or install it:',
          ...blocker.commands,
        ].join('\n'),
      }),
    ]);
  });

  it('fixes a deselected Xcode with the exact command, and a runtime that follows from it with a pointer', async () => {
    await approvedCredential();
    const { findings } = await inspectBuildMachines(
      {
        fix: false,
        check: () =>
          Promise.resolve({
            capacity: null,
            problems: [
              {
                code: 'xcode',
                reason: 'no Xcode there: xcode-select points at Command Line Tools',
                commands: ['sudo xcode-select -s /Applications/Xcode-27.1.app/Contents/Developer'],
                lead: 'select Xcode-27.1',
              },
              { code: 'runtime', reason: 'no iPhone simulator on iOS-27-0 there', followsFrom: 'xcode' },
              {
                code: 'cocoapods',
                reason: 'CocoaPods 1.17.0 there, 1.16.2 here',
              },
            ],
          }),
      },
      fakeIo([approved()]).io,
      ['mini'],
    );
    expect(findings.map(({ code, fix }) => ({ code, fix }))).toEqual([
      {
        code: 'build-machine-xcode',
        fix: 'On mini, select Xcode-27.1:\nsudo xcode-select -s /Applications/Xcode-27.1.app/Contents/Developer',
      },
      { code: 'build-machine-runtime', fix: 'Fix the xcode problem on mini first; this follows from it.' },
      expect.objectContaining({ code: 'build-machine-cocoapods' }),
    ]);
  });

  it('forgets the pairing of a machine no longer named, with --fix only', async () => {
    await askedPending();
    await inspectBuildMachines({ fix: false }, fakeIo([]).io, []);
    expect(readBuildMachines()).toHaveLength(1);
    await inspectBuildMachines({ fix: true }, fakeIo([]).io, []);
    expect(readBuildMachines()).toEqual([]);
  });

  it('does not read a protocol 1 credential, which pinned a tailnet node and held a device token', () => {
    writeFileSync(
      buildMachinesFile(),
      JSON.stringify({
        version: 1,
        machines: [
          {
            machine: 'mini',
            nodeId: 'nMini',
            dnsName: 'mini',
            deviceId: 'ab12',
            deviceToken: 't',
            state: 'approved',
            requestedAt: 'x',
          },
        ],
      }),
    );
    expect(readBuildMachines()).toEqual([]);
  });
});

it.each([{ machines: 'mini' }, { machines: ['mini', 42] }, 'mini'])(
  'doctor --fix keeps saved credentials when remote is invalid: %j',
  async (remote) => {
    await askedPending();
    const saved = readFileSync(buildMachinesFile(), 'utf8');
    writeFileSync(getConfigPath(), JSON.stringify({ remote }));
    const { io, calls } = fakeIo([]);
    const result = await inspectBuildMachines({ fix: true }, io);
    expect(result.findings).toEqual([expect.objectContaining({ title: 'Invalid remote.machines setting' })]);
    expect(readFileSync(buildMachinesFile(), 'utf8')).toBe(saved);
    expect(calls).toEqual([]);
  },
);
