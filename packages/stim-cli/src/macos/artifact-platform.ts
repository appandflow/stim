import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';

export async function validateMacosArtifactPlatform(
  context: StimContext,
  bundle: string,
  product: string,
  signal: AbortSignal,
): Promise<void> {
  const binary = join(bundle, 'Contents', 'MacOS', product);
  const options = { timeoutMs: 30_000, signal, declareFor: context };
  const architecture = process.arch === 'x64' ? 'x86_64' : process.arch;
  const archs = await getExecutor().runFileAsync('xcrun', ['lipo', '-archs', binary], options);
  const platform = await getExecutor().runFileAsync(
    'xcrun',
    ['vtool', '-arch', architecture, '-show-build', binary],
    options,
  );
  if (!archs.trim().split(/\s+/).includes(architecture) || !/^\s*platform\s+MACOS\s*$/m.test(platform))
    throw new Error('The cached macOS executable does not match this platform and architecture.');
}
