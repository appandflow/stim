import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import { getExecutor } from '../exec.ts';
import { logLines } from '../macos/run.ts';
import { resolveBundleExtras, setBundleName, stageBundle, validateInfoPlist } from '../macos/stage.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { macosToolchain } from '../offload/toolchain.ts';
import { repoRoot } from '../workspace/worktree.ts';
import type { MacosProject } from './macos-project.ts';

export function swiftpmMacosProject(root: string): MacosProject {
  return {
    prepare(settings) {
      const macos = settings.macos as
        | { product?: string; infoPlist?: string; arguments?: string[]; resources?: unknown; assetCatalog?: unknown }
        | undefined;
      if (!macos?.product || !macos.infoPlist) {
        throw Object.assign(
          new Error('Set macos.product and macos.infoPlist explicitly in .stim.json. See stim guide macos.'),
          { code: 'STIM_BAD_ARG' },
        );
      }
      const { product, infoPlist } = macos;
      const { bundleId } = validateInfoPlist(root, product, infoPlist);
      const repository = realpathSync(repoRoot(root) ?? root);
      const extras = resolveBundleExtras(root, repository, macos.resources, macos.assetCatalog);
      return {
        product,
        arguments: macos.arguments ?? [],
        bundleId,
        async compile({ scratch, writer, note }) {
          await tool(
            root,
            ['build', '-c', 'debug', '--product', product, '--scratch-path', scratch, '--jobs', '2'],
            writer,
            note,
          );
          return tool(
            root,
            ['build', '-c', 'debug', '--scratch-path', scratch, '--show-bin-path'],
            writer,
            () => {},
            true,
          );
        },
        stage: (bin, bundle, id, displayName) =>
          stageBundle(root, product, infoPlist, bin, bundle, id, extras, displayName),
        validateFetched(bundle, id, displayName) {
          const executable = join(bundle, 'Contents', 'MacOS', product);
          const plist = JSON.parse(
            getExecutor().runFile('plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Info.plist')]),
          );
          if (plist.CFBundleIdentifier !== id || plist.CFBundleExecutable !== product || !existsSync(executable))
            throw new Error('The fetched macOS bundle does not match the requested identity and executable.');
          for (const destination of [
            ...Object.keys(extras.resources),
            ...(extras.assetCatalog ? ['Assets.car'] : []),
          ]) {
            if (!existsSync(join(bundle, 'Contents', 'Resources', destination)))
              throw new Error(`The fetched macOS bundle lacks declared resource ${destination}.`);
          }
          if (displayName !== undefined) {
            setBundleName(join(bundle, 'Contents', 'Info.plist'), displayName);
            getExecutor().runFile('codesign', ['--force', '--sign', '-', bundle]);
          }
          getExecutor().runFile('codesign', ['--verify', '--strict', bundle]);
        },
        offload: {
          target: () => ({ platform: 'macos', local: macosToolchain() }),
          request: (id) => ({
            platform: 'macos',
            product,
            infoPlist: relative(root, resolve(root, infoPlist)),
            bundleId: id,
            resources: Object.fromEntries(
              Object.entries(extras.resources).map(([destination, source]) => [
                destination,
                relative(repository, source),
              ]),
            ),
            assetCatalog: extras.assetCatalog ? relative(repository, extras.assetCatalog) : null,
          }),
        },
      };
    },
  };
}

async function tool(
  root: string,
  args: string[],
  writer: NdjsonWriter,
  note: (line: string) => void,
  capture = false,
): Promise<string> {
  const child = spawnDeclared(() =>
    getExecutor().spawn('swift', args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    if (capture) stdout += chunk.toString('utf8');
  });
  const write = (msg: string) => {
    writer.write({ src: 'build', platform: 'macos', level: 'debug', msg });
    note(msg);
  };
  if (child.stdout) logLines(child.stdout, write);
  if (child.stderr) logLines(child.stderr, write);
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? done() : reject(new Error(`swift ${args[0]} failed (${code}). See stim logs --source build.`)),
    );
  });
  return stdout.trim();
}
