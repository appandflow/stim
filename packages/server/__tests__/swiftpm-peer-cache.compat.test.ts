import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stimBuildDigest } from '@stim-cli/core/state';
import { getExecutor } from '../../stim-cli/src/exec.ts';
import { processContext } from '../../stim-cli/src/cli-operation.ts';
import { validateMacosArtifactPlatform } from '../../stim-cli/src/macos/artifact-platform.ts';
import { reidentifyBundle } from '../../stim-cli/src/macos/stage.ts';
import { manifestDigest } from '../../stim-cli/src/offload/manifest.ts';
import { BuildHost } from '../src/build.ts';
import type { BuildSwiftpmArtifactQuery } from '@stim-cli/core/protocol';

test('real SwiftPM app reuse survives worker checkout and output removal without another compilation', async () => {
  if (process.platform !== 'darwin') throw new Error('macOS, Xcode and its macOS SDK are required.');
  const executor = getExecutor();
  const load = await executor.runFileAsync('sysctl', ['-n', 'vm.loadavg'], { timeoutMs: 10_000 });
  if (
    load
      .replace(/[{}]/g, '')
      .trim()
      .split(/\s+/)
      .some((value) => Number(value) > 80)
  )
    throw new Error('Native validation waits until every MacBook load average is at most 80.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stim-swiftpm-peer-compat-')));
  const home = join(root, 'home');
  const project = join(root, 'client');
  const tools = join(root, 'tools');
  const cli = fileURLToPath(new URL('../../stim-cli/dist/cli.mjs', import.meta.url));
  const worker = fileURLToPath(new URL('../../stim-cli/dist/offload-worker.mjs', import.meta.url));
  let host: BuildHost | undefined;
  let session: ReturnType<BuildHost['session']> | undefined;
  vi.stubEnv('STIM_HOME', home);
  const command = (file: string, args: string[]) =>
    executor.runFileAsync(file, args, { cwd: root, timeoutMs: 120_000 });
  try {
    await mkdir(project);
    await command(process.execPath, [cli, 'settings', 'set', 'iosSimulatorApp', 'stim-desktop']);
    await command(process.execPath, [cli, 'settings', 'set', 'androidEmulatorApp', 'stim-desktop']);
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({
        iosSimulatorApp: 'stim-desktop',
        androidEmulatorApp: 'stim-desktop',
        server: { maxLoadPerCore: 100_000 },
      }),
    );
    await mkdir(tools);
    const swift = join(tools, 'swift');
    await writeFile(
      swift,
      `#!/bin/sh
if [ "$1" = build ]; then
  case " $* " in
    *" --show-bin-path "*) ;;
    *) printf 'compile\\n' >> "$STIM_SWIFTPM_PROBE_COUNT" ;;
  esac
  exec "$STIM_SWIFTPM_PROBE_REAL_SWIFT" "$@" --jobs 2
fi
exec "$STIM_SWIFTPM_PROBE_REAL_SWIFT" "$@"
`,
    );
    await chmod(swift, 0o755);
    const counter = join(root, 'compile-count');
    const environment = {
      ...process.env,
      PATH: `${tools}:${process.env.PATH ?? ''}`,
      STIM_SWIFTPM_PROBE_COUNT: counter,
      STIM_SWIFTPM_PROBE_REAL_SWIFT: '/usr/bin/swift',
    };
    const files = new Map<string, string>([
      [
        'Package.swift',
        `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "PeerCacheApp", platforms: [.macOS(.v14)], products: [.executable(name: "PeerCacheApp", targets: ["PeerCacheApp"])], targets: [.executableTarget(name: "PeerCacheApp", linkerSettings: [.unsafeFlags(["-Xlinker", "-headerpad_max_install_names"])])])
`,
      ],
      [
        'Sources/PeerCacheApp/main.swift',
        `import Foundation
let path = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/Metadata.txt")
print(try String(contentsOf: path, encoding: .utf8), terminator: "")
`,
      ],
      [
        'Info.plist',
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.stim.peer.compat</string><key>CFBundleExecutable</key><string>PeerCacheApp</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>',
      ],
      ['metadata.txt', 'relocated SwiftPM resource\n'],
    ]);
    await command('git', ['init', '-q', project]);
    for (const [path, content] of files) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), content);
    }
    const manifest = [...files].map(([path, content]) => ({
      path,
      kind: 'file' as const,
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    }));
    const stimBuild = stimBuildDigest(dirname(worker));
    if (!stimBuild) throw new Error('Build the CLI before running this native compatibility probe.');
    const query: BuildSwiftpmArtifactQuery = {
      project: '',
      sourceDigest: manifestDigest(manifest),
      stimBuild,
      inputs: {
        complete: true,
        ignored: [],
        outputs: [],
        localFiles: [swift],
        environment: ['STIM_SWIFTPM_PROBE_REAL_SWIFT'],
      },
      build: {
        product: 'PeerCacheApp',
        infoPlist: 'Info.plist',
        resources: { 'Metadata.txt': 'metadata.txt' },
        assetCatalog: null,
      },
    };
    host = new BuildHost({ worker, env: environment, limits: { timeoutMs: 120_000, killGraceMs: 1000 } });
    const frames: Buffer[] = [];
    const logs: unknown[] = [];
    session = host.session(
      'compat-builder',
      {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        send: (frame: Buffer) => {
          frames.push(frame);
        },
      },
      (entry) => {
        logs.push(entry);
      },
    );
    const sync = session.sync({ repo: 'swiftpm-compat', files: manifest, done: true });
    if ('error' in sync) throw new Error(sync.error.message);
    for (const file of manifest.filter((entry) => sync.result.missing.includes(entry.sha256)))
      expect(
        session.blob(Buffer.concat([Buffer.from(file.sha256, 'hex'), Buffer.from(files.get(file.path) ?? '')])),
      ).toBeNull();
    const start = await session.start({
      repo: 'swiftpm-compat',
      project: '',
      platform: 'macos',
      fingerprint: query.sourceDigest,
      stimBuild,
      cacheArtifact: true,
      macos: { ...query.build, bundleId: 'dev.stim.peer.compat', artifactInputs: query.inputs },
    });
    if ('error' in start) throw new Error(start.error.message);
    const job = host.attach('compat-builder', start.result.job, session);
    if (!job) throw new Error('The admitted native build disappeared.');
    await job.done;
    if (!job.outcome?.ok) throw new Error(JSON.stringify({ outcome: job.outcome, logs }));
    host.forget(job);
    const area = join(host.clientDir('compat-builder'), 'repos', 'swiftpm-compat');
    for (const directory of ['src', 'macos', 'out']) await rm(join(area, directory), { recursive: true });
    host.drain('native cache acceptance');
    const offer = await host.offer('compat-builder', { repo: 'swiftpm-compat', swiftpmArtifact: query });
    if ('error' in offer || !offer.result.artifact) throw new Error(JSON.stringify({ offer, logs }));
    expect(host.running()).toBe(0);
    expect(offer.result.capacity.declined).toBe('native cache acceptance');
    expect(
      await session.cachedArtifact({ repo: 'swiftpm-compat', artifact: offer.result.artifact, swiftpmArtifact: query }),
    ).toEqual({ result: offer.result.artifact });
    const downloaded = join(root, 'download');
    await mkdir(downloaded);
    const archive = join(downloaded, 'app.tgz');
    await writeFile(archive, Buffer.concat(frames.map((frame) => frame.subarray(32))));
    await command('tar', ['-xf', archive, '-C', downloaded]);
    const app = join(downloaded, 'PeerCacheApp.app');
    const context = processContext(root, new AbortController().signal);
    await reidentifyBundle(context, app, 'dev.stim.peer.compat.receiver');
    expect(
      await command('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]),
    ).toBe('dev.stim.peer.compat.receiver');
    await command('codesign', ['--verify', '--strict', app]);
    await validateMacosArtifactPlatform(context, app, 'PeerCacheApp', context.signal);
    expect(await command(join(app, 'Contents/MacOS/PeerCacheApp'), [])).toBe('relocated SwiftPM resource');
    expect(await readFile(counter, 'utf8')).toBe('compile\n');
    console.log(
      JSON.stringify({
        cacheHit: true,
        compilerInvocations: 1,
        workerCheckoutRemoved: true,
        workerOutputRemoved: true,
        artifact: offer.result.artifact.sha256,
      }),
    );
  } finally {
    session?.close(false);
    await host?.close();
    if (host) await host.remove('compat-builder');
    await command(process.execPath, [cli, 'worktree', 'remove', project]);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
