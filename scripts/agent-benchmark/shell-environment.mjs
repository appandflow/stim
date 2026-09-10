import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const benchmarkLocale = 'C.UTF-8';
const localeKeys = ['LANG', 'LC_ALL', 'LC_CTYPE'];

export function benchmarkEnvironment(environment) {
  const clean = { ...environment };
  for (const key of ['GEM_HOME', 'GEM_PATH', 'RUBY_VERSION', 'LC_MESSAGES']) delete clean[key];
  for (const key of localeKeys) clean[key] = benchmarkLocale;
  return clean;
}

export function isolatedShellEnvironment(environment, directory) {
  const clean = benchmarkEnvironment(environment);
  const shellHome = join(directory, 'shell-home');
  mkdirSync(shellHome, { recursive: true });
  const startup =
    ['PATH', ...localeKeys].map((key) => `export ${key}='${String(clean[key]).replaceAll("'", "'\\''")}'\n`).join('') +
    'unset LC_MESSAGES\n';
  writeFileSync(join(shellHome, '.zshenv'), startup);
  writeFileSync(join(shellHome, '.zprofile'), startup);
  return { ...clean, ZDOTDIR: shellHome };
}
