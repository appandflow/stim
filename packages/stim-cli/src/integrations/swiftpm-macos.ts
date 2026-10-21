import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import { getExecutor } from '../exec.ts';
import { logLines } from '../macos/run.ts';
import { swiftpmArtifactCache } from '../macos/artifact-cache.ts';
import { resolveBundleExtras, setBundleName, stageBundle, validateInfoPlist } from '../macos/stage.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { macosToolchainAsync } from '../offload/toolchain.ts';
import { repoRootAsync } from '../workspace/worktree.ts';
import type { MacosArtifactRecipe, MacosProject } from './macos-project.ts';
import { type StimContext } from '@stim-cli/core';

export function swiftpmMacosProject(root: string): MacosProject {
  return {
    async prepare(context, settings) {
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
      const { bundleId } = await validateInfoPlist(context, root, product, infoPlist);
      const repository = realpathSync(
        (await repoRootAsync(root, { env: context.env, signal: context.signal })) ?? root,
      );
      const extras = resolveBundleExtras(root, repository, macos.resources, macos.assetCatalog);
      const recipe: MacosArtifactRecipe = {
        product,
        arguments: macos.arguments ?? [],
        bundleId,
        async compile({ scratch, writer, note }) {
          await tool(
            context,
            root,
            ['build', '-c', 'debug', '--product', product, '--scratch-path', scratch, '--jobs', '2'],
            writer,
            note,
          );
          return tool(
            context,
            root,
            ['build', '-c', 'debug', '--scratch-path', scratch, '--show-bin-path'],
            writer,
            () => {},
            true,
          );
        },
        stage: (bin, bundle, id, displayName) =>
          stageBundle(context, root, product, infoPlist, bin, bundle, id, extras, displayName),
        async validateFetched(bundle, id, displayName) {
          const executable = join(bundle, 'Contents', 'MacOS', product);
          const plist = JSON.parse(
            await getExecutor().runFileAsync(
              'plutil',
              ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Info.plist')],
              {
                timeoutMs: 10_000,
                declareFor: context,
              },
            ),
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
            await setBundleName(context, join(bundle, 'Contents', 'Info.plist'), displayName);
            await getExecutor().runFileAsync('codesign', ['--force', '--sign', '-', bundle], {
              timeoutMs: 'unbounded',
              declareFor: context,
            });
          }
          await getExecutor().runFileAsync('codesign', ['--verify', '--strict', bundle], {
            timeoutMs: 'unbounded',
            declareFor: context,
          });
        },
        offload: {
          target: async (runsOnWorker) => ({
            platform: 'macos',
            local: await macosToolchainAsync(),
            ...(runsOnWorker ? { runsOnWorker: true as const } : {}),
          }),
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
      recipe.cache = swiftpmArtifactCache(context, root, settings, recipe, {
        product,
        infoPlist,
        resources: Object.fromEntries(
          Object.entries(extras.resources).map(([destination, source]) => [destination, relative(root, source)]),
        ),
        assetCatalog: extras.assetCatalog ? relative(root, extras.assetCatalog) : null,
      });
      return recipe;
    },
  };
}

async function tool(
  context: StimContext,
  root: string,
  args: string[],
  writer: NdjsonWriter,
  note: (line: string) => void,
  capture = false,
): Promise<string> {
  const child = spawnDeclared(context, () =>
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
