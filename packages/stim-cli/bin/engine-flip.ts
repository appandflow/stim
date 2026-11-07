import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { claimsHeld, readBuildClaims } from '../src/engine-store/claims.ts';
import { takeLock } from '../src/engine-store/locks.ts';
import { engineRoot, readRecords } from '../src/engine-store/store.ts';

const root = engineRoot(process.env);
try {
  const store = await takeLock(root, '.lock.sock');
  if (store) {
    try {
      const flip = await takeLock(root, '.flip.sock');
      if (flip) {
        try {
          const { current, staged } = readRecords(root);
          if (current && staged && current.dir !== staged.dir && !claimsHeld(readBuildClaims(root))) {
            const selector = join(root, staged.dir, 'dist', 'engine-select.mjs');
            process.argv = [process.execPath, selector, '--flip'];
            await import(pathToFileURL(selector).href);
          }
        } finally {
          await flip.release();
        }
      }
    } finally {
      await store.release();
    }
  }
} catch (error) {
  if (error instanceof Error && 'socketPath' in error && 'code' in error && typeof error.code === 'string')
    process.stdout.write(`${JSON.stringify({ lockError: { code: error.code, socketPath: error.socketPath } })}\n`);
  else throw error;
}
