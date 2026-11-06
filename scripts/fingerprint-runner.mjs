import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  cleanupWorktrees,
  mutation,
  temporaryWorktree,
} from '../packages/stim-cli/src/__tests__/fingerprint-parity-harness.ts';
import { git, rows, verdict } from '../packages/stim-cli/src/__tests__/fingerprint-parity-rows.ts';

export async function run(projects, oracle) {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.once(signal, () => {
      try {
        cleanupWorktrees();
      } finally {
        process.exit(code);
      }
    });
  }
  if (!projects.length) {
    console.error(
      'Pass installed project roots as arguments' + (oracle ? ' or STIM_PARITY_PROJECTS (colon-separated).' : '.'),
    );
    process.exitCode = 1;
  }
  for (const project of projects) {
    try {
      const source = resolve(project);
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
      const deps = { ...manifest.devDependencies, ...manifest.dependencies };
      console.log(`\n${source}: ${deps.expo ? 'expo' : 'bare'}`);
      const require = createRequire(join(source, 'package.json'));
      const installed = (name) => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8'));
      let rn;
      try {
        rn = installed('react-native').version;
      } catch {
        throw new Error('not installed: missing node_modules containing react-native; install this fixture first');
      }
      const sdk = deps.expo ? installed('expo').version : 'none';
      console.log(
        `Expo ${sdk}, RN ${rn}, ${git(source, 'ls-files', '--', 'ios', 'android') ? 'tracked native' : 'no tracked native'}`,
      );
      for (const platform of oracle ? ['ios'] : ['ios', 'android']) {
        const output = [];
        for (const row of rows) {
          let checkout;
          const cells = {
            row: row.id,
            class: row.class,
            'expo moved': 'n/a',
            'stim moved': 'n/a',
            verdict: 'n/a',
            'ms for stim': '-',
          };
          try {
            if (row.platform && row.platform !== platform) continue;
            checkout = temporaryWorktree(source);
            if (!row.applies(checkout.root)) continue;
            const result = await mutation(row, checkout.root, undefined, platform, oracle);
            const outcome = verdict(row, result);
            Object.assign(cells, {
              'expo moved': oracle ? result.expoMoved : '-',
              'stim moved': result.stimMoved,
              verdict: outcome.label,
              'ms for stim': result.ms,
            });
            if (!outcome.ok) process.exitCode = 1;
          } catch (error) {
            cells.verdict = error.message;
            process.exitCode = 1;
          } finally {
            output.push(cells);
            if (checkout) checkout.cleanup();
          }
        }
        console.log(`${platform} mutations:`);
        console.table(output);
      }
    } catch (error) {
      console.error(`${project}: ${error.message}`);
      process.exitCode = 1;
    } finally {
      cleanupWorktrees();
    }
  }
}
