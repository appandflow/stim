import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function injectedImportProblems(directory) {
  const problems = [];
  for (const name of readdirSync(directory, { recursive: true }).filter((entry) => entry.endsWith('.cjs'))) {
    const file = join(directory, name);
    const source = readFileSync(file, 'utf8');
    const requireFromFile = createRequire(resolve(file));
    const imports =
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\b(?:import|export)\s+(?:[^;]*?\sfrom\s*)?)(['"`])([^'"`]+)\1|(['"`])(?:\\.|(?!\3)[^\\])*?\3/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[2];
      if (!specifier || specifier.startsWith('node:')) continue;
      if (specifier.startsWith('./')) {
        try {
          if (dirname(realpathSync(requireFromFile.resolve(specifier))) === realpathSync(directory)) continue;
        } catch {}
      }
      const line = source.slice(0, match.index).split('\n').length;
      problems.push(`${file}:${line}: injected import ${specifier} must use node:* or a sibling file`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = fileURLToPath(new URL('../packages/stim-cli/src/injected/', import.meta.url));
  const problems = injectedImportProblems(directory);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}
