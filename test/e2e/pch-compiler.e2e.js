import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutor } from '../../packages/stim-cli/src/exec.ts';

test('PCH preprocessing rewrites only successful in-workspace linemarkers, in files or stdout', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-pch-output-')));
  const savedHome = process.env.STIM_HOME;
  process.env.STIM_HOME = join(directory, 'home');
  try {
    const root = join(directory, 'checkout');
    const build = join(root, 'build');
    mkdirSync(build, { recursive: true });
    const input = [
      `# 12 ${JSON.stringify(join(root, 'include/a "quoted".h'))} 1 3`,
      `# 2 ${JSON.stringify(root + '-sibling/not-ours.h')} 2`,
      '# 1 "<built-in>" 3',
      `const char *path = ${JSON.stringify(join(root, 'source.cpp'))};`,
      `#line 20 ${JSON.stringify(join(root, 'authored.cpp'))}`,
      `# 1 "${root}/bad\\q.h" 1`,
      '',
    ].join('\n');
    const expected = input.replace(JSON.stringify(join(root, 'include/a "quoted".h')), '"../include/a \\"quoted\\".h"');
    const compiler = join(directory, 'compiler.mjs');
    writeFileSync(
      compiler,
      `import { writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('-o') + 1];
const bytes = Buffer.from(process.env.PCH_TEST_INPUT, 'base64');
if (output === '-') process.stdout.write(bytes);
else writeFileSync(output, bytes);
process.exitCode = Number(process.env.PCH_TEST_EXIT || 0);
`,
    );
    const wrapper = fileURLToPath(new URL('../../packages/stim-cli/dist/pch-compiler.mjs', import.meta.url));
    const run = (output, bytes, status = 0) =>
      getExecutor().runFile(
        process.execPath,
        [
          wrapper,
          process.execPath,
          compiler,
          '-E',
          '-relocatable-pch',
          '-Xclang',
          '-isysroot',
          '-Xclang',
          '..',
          '-o',
          output,
        ],
        {
          cwd: build,
          env: { ...process.env, PCH_TEST_INPUT: bytes.toString('base64'), PCH_TEST_EXIT: String(status) },
        },
      );
    assert.equal(run('-', Buffer.from(input)), expected.trim());
    const output = join(directory, 'output.ii');
    run(output, Buffer.from(input));
    assert.equal(readFileSync(output, 'utf8'), expected);
    assert.throws(
      () => run(output, Buffer.from(input), 23),
      (error) => error.status === 23,
    );
    assert.equal(readFileSync(output, 'utf8'), input, 'failed compiler output is untouched');
    const nonUtf8 = Buffer.concat([Buffer.from(input), Buffer.from([0xff])]);
    run(output, nonUtf8);
    assert.deepEqual(readFileSync(output), nonUtf8, 'unsupported encoding is preserved byte-for-byte');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = savedHome;
  }
});
