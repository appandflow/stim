import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testContext } from './_context.ts';
import { nativeXcodeIdentityContext, writeNativeXcodeProject } from './_native-xcode-project.ts';
import { nativeXcodeIosProject } from '../integrations/native-xcode-ios.ts';
import { resetExecutor } from '../exec.ts';

test('real Xcode toolchain probes produce a reusable native artifact identity', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-xcode-toolchain-')));
  try {
    resetExecutor();
    writeNativeXcodeProject(root);
    const context = testContext({ cwd: root, projectRoot: root, env: { ...process.env } });
    const recipe = nativeXcodeIosProject(root).artifact(nativeXcodeIdentityContext(root, context));
    const identity = await recipe.identity();
    expect(identity).toHaveProperty('key');
    expect(identity).not.toHaveProperty('cacheIneligible');
    expect(await recipe.validate()).toEqual(identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
