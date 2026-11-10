import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { defineConfig } from 'tsdown';
import { SETTINGS_SCHEMA_FILE, settingsJsonSchema } from '@stim-cli/core/state';
import { PROTOCOL_SCHEMA_FILE, protocolJsonSchema } from '../server/src/protocol.ts';

const { engines, version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const nodeFloor = /^>=(\d+\.\d+\.\d+)$/.exec(engines.node)?.[1];
if (!nodeFloor) throw new Error(`engines.node must have the form >=X.Y.Z, got ${engines.node}`);

const viewer = (name: string) => readFileSync(`../server/share-viewer/${name}`, 'utf8');

export default defineConfig({
  entry: {
    cli: 'bin/node-check.ts',
    status: 'src/cli/status-entry.ts',
    api: 'src/api.ts',
    plugin: 'src/plugin.ts',
    ci: '../ci/src/index.ts',
    'ci/artifacts': '../ci/src/artifacts.ts',
    'stim-server': 'bin/stim-server.ts',
    'stim-service-runner': '../server/src/service-runner.ts',
    protocol: '../server/src/protocol.ts',
    'android-cas-compiler': 'bin/android-cas-compiler.ts',
    'cache-manifest': 'src/cache/cache-manifest.ts',
    'pull-requests': 'src/pull-request-state.ts',
    'share-links': 'src/workspace/share-links.ts',
    'attached-stimd': 'src/stimd/attached.ts',
    'build-artifact-cache': 'src/offload/build-artifact-cache.ts',
    'stimd-thread': 'src/stimd/threads.ts',
    'stimd-status': 'src/stimd/status-thread.ts',
    'net-thread': '../server/src/net-thread.ts',
    'kit-worker': 'src/kit-worker.ts',
    'supervisor-run': 'src/supervisor/run.ts',
    'macos-run': 'src/macos/run.ts',
    'device-host-worker': 'src/device-host/run.ts',
    'status-worker': 'src/status-worker.ts',
    'fingerprint-precompute': 'bin/fingerprint-precompute.ts',
    'windows-report': 'bin/windows-report.ts',
    'engine-select': 'bin/engine-select.ts',
    'engine-flip': 'bin/engine-flip.ts',
    'engine-state': 'src/engine-state.ts',
    '__self-test': 'bin/self-test.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  alias: {
    '@stim-cli/ci/cli': resolve('../ci/src/cli.ts'),
    '@stim-cli/server/build': resolve('../server/src/build.ts'),
    '@stim-cli/server/cli': resolve('../server/src/cli.ts'),
    '@stim-cli/server/hosted-relay': resolve('../server/src/hosted-relay.ts'),
    '@stim-cli/server/environment': resolve('../server/src/environment.ts'),
    '@stim-cli/server/release-install': resolve('../server/src/release-install.ts'),
    '@stim-cli/server/service-plist': resolve('../server/src/service-plist.ts'),
  },
  noExternal: [/^@stim-cli\//],
  deps: { neverBundle: ['stim', /^stim\//, '@expo/fingerprint', /^@expo\/fingerprint\//] },
  outputOptions: {
    advancedChunks: {
      includeDependenciesRecursively: false,
      groups: [
        {
          name: 'server',
          test: (id) => /[\\/]packages[\\/]server[\\/]/.test(id) && !id.endsWith('/service-runner.ts'),
        },
        { name: 'transport-tailscale', test: /[\\/]packages[\\/]transport-tailscale[\\/]/ },
        { name: 'agent-driver-agent-device', test: /[\\/]packages[\\/]agent-driver-agent-device[\\/]/ },
      ],
    },
  },
  define: { NODE_FLOOR: JSON.stringify(nodeFloor), STIM_CI_VERSION: JSON.stringify(version) },
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
  hooks: {
    'build:done': () => {
      mkdirSync('dist/injected', { recursive: true });
      for (const name of readdirSync('src/injected').filter((entry) => /\.(cjs|d\.cts)$/.test(entry)))
        copyFileSync(`src/injected/${name}`, `dist/injected/${name}`);
      writeFileSync(`dist/${SETTINGS_SCHEMA_FILE}`, `${JSON.stringify(settingsJsonSchema(), null, 2)}\n`);
      copyFileSync('helper/stim-footprint.swift', 'dist/stim-footprint.swift');
      copyFileSync('helper/stim-clonefile.c', 'dist/stim-clonefile.c');
      copyFileSync('helper/stim-privsize.c', 'dist/stim-privsize.c');
      copyFileSync('helper/windows-report.ps1', 'dist/windows-report.ps1');
      writeFileSync(`dist/${PROTOCOL_SCHEMA_FILE}`, `${JSON.stringify(protocolJsonSchema(), null, 2)}\n`);
      rmSync('dist/stim-host', { recursive: true, force: true });
      mkdirSync('dist/stim-host');
      for (const name of ['stim-host.c', 'Info.plist'])
        copyFileSync(`../server/host/${name}`, `dist/stim-host/${name}`);
      rmSync('dist/share-viewer', { recursive: true, force: true });
      cpSync('../server/share-viewer', 'dist/share-viewer', { recursive: true });
      writeFileSync(
        'dist/share-viewer/not-running.html',
        viewer('not-running.html')
          .replace('{{css}}', () => viewer('viewer.css'))
          .replace('{{logo}}', () => viewer('logo.svg').trim()),
      );
      rmSync('dist/stim-frames', { recursive: true, force: true });
      mkdirSync('dist/stim-frames');
      const desktop = readFileSync('../server/helper/desktop-sources.txt', 'utf8').split(/\s+/).filter(Boolean);
      for (const source of [
        '../server/helper/main.swift',
        '../server/helper/VideoEncoder.swift',
        '../server/helper/PhoneSource.swift',
        '../server/helper/FrameArtwork.swift',
        '../server/helper/MacosSource.swift',
        '../server/helper/DuoFrameRenderer.swift',
        '../server/helper/DuoHingeMonitor.swift',
        '../server/helper/DuoCaptureSource.swift',
        ...desktop.map((path) => `../../apps/desktop/Sources/${path}`),
      ]) {
        copyFileSync(source, `dist/stim-frames/${basename(source)}`);
      }
      copyFileSync('../../apps/desktop/Support/Siniulator-LICENSE.txt', 'dist/stim-frames/Siniulator-LICENSE.txt');
      copyFileSync('../../apps/desktop/Support/SimFold/main.m', 'dist/stim-frames/sim-fold.m');
      copyFileSync('../../apps/desktop/Support/SimFold/entitlements.plist', 'dist/stim-frames/sim-fold.entitlements');
      rmSync('dist/scrcpy', { recursive: true, force: true });
      mkdirSync('dist/scrcpy');
      for (const name of ['scrcpy-server', 'LICENSE', 'NOTICE'])
        copyFileSync(`../server/helper/scrcpy/${name}`, `dist/scrcpy/${name}`);
    },
  },
});
