import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isUnitTestFile } from './ci-unit-test-pattern.mjs';

const darwinGated = [
  /process\.platform\s*!==\s*'darwin'/,
  /(?<!skipIf\()process\.platform\s*===\s*'darwin'/,
  /skipIf\(!existsSync\('\/bin\/zsh'\)\)/,
  /skipIf\(!caseInsensitive\)/,
];

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(isUnitTestFile)
  .filter((file) => {
    const source = readFileSync(file, 'utf8');
    return darwinGated.some((pattern) => pattern.test(source));
  });
console.error(`Darwin-gated unit suite: ${files.length} files`);
process.stdout.write(files.map((file) => `${file}\0`).join(''));
