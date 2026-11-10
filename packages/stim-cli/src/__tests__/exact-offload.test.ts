import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  EXACT_SIM_TARGET,
  exactOffloadParam,
  exactLocalToolProblems,
  exactOffloadPlan,
  exactToolProblems,
} from '../integrations/exact-offload.ts';
import { exactDoctor } from '../integrations/exact-ios.ts';

let root: string;
let app: string;
let exact2: string;
let sha: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-exact-offload-'));
  exact2 = join(root, 'pins', 'exact2');
  mkdirSync(exact2, { recursive: true });
  writeFileSync(join(exact2, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.97.0"\n');
  git(exact2, 'init', '-q');
  git(exact2, 'add', '.');
  git(exact2, 'commit', '-q', '-m', 'pin');
  sha = git(exact2, 'rev-parse', 'HEAD');
  app = join(root, 'apps', 'shop-app');
  mkdirSync(app, { recursive: true });
  writeFileSync(
    join(app, 'exact.mjs'),
    [
      '#!/bin/sh',
      `const EXACT2 = resolve(import.meta.dir, process.env.EXACT2 ?? "../../pins/exact2");`,
      'ensureBun("1.4.2");',
    ].join('\n'),
  );
  writeFileSync(join(app, 'app.json'), JSON.stringify({ env: ['API_URL', 'STORE_ID', 'REGION', 'UNSET', 'lower'] }));
  writeFileSync(join(app, '.env.local'), 'API_URL=from-file\nSTORE_ID="42"\nOTHER=secret\n');
  writeFileSync(join(app, '.env'), 'STORE_ID=1\nREGION=ca\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('an offload carries the pins, the app directory name and the declared settings in Exact order', () => {
  expect(exactOffloadPlan(app, { API_URL: 'from-shell' })).toEqual({
    name: 'shop-app',
    exact2: sha,
    bun: '1.4.2',
    rust: '1.97.0',
    env: { API_URL: 'from-shell', STORE_ID: '42', REGION: 'ca' },
  });
});

test.each([
  [
    'native modules',
    () => writeFileSync(join(app, 'app.json'), JSON.stringify({ modules: ['shop-map'] })),
    /native modules/,
  ],
  [
    'a changed exact2',
    () => writeFileSync(join(exact2, 'rust-toolchain.toml'), 'channel = "1.98.0"\n'),
    /local changes/,
  ],
  ['no exact2 there', () => rmSync(exact2, { recursive: true }), /no exact2 checkout/],
])('an app with %s builds here', (_name, change, reason) => {
  change();
  const plan = exactOffloadPlan(app, {});
  expect('unsupported' in plan && plan.unsupported).toMatch(reason);
});

test('EXACT2 in the environment overrides the launcher default', () => {
  const moved = join(root, 'elsewhere');
  execFileSync('git', ['clone', '-q', exact2, moved]);
  rmSync(exact2, { recursive: true });
  expect(exactOffloadPlan(app, { EXACT2: moved })).toMatchObject({ exact2: sha });
});

test('a worker refuses a malformed Exact build request', () => {
  const valid = { name: 'shop-app', exact2: sha, bun: '1.4.2', rust: '1.97.0', env: { API_URL: 'x' } };
  expect(exactOffloadParam(valid)).toEqual(valid);
  for (const bad of [
    { ...valid, name: '../escape' },
    { ...valid, exact2: 'main' },
    { ...valid, env: { 'BAD-NAME': 'x' } },
    { ...valid, env: { API_URL: 1 } },
  ])
    expect(exactOffloadParam(bad)).toBeNull();
});

test("a machine reports each missing piece of Exact's toolchain with the command that installs it", () => {
  const home = join(root, 'home');
  const pins = { exact2: sha, bun: '1.4.2', rust: '1.97.0' };
  const bare = exactToolProblems(pins, { HOME: home });
  expect(bare.map((each) => each.reason)).toEqual([
    'no Bun 1.4.2 at ~/.bun-1.4.2',
    'no rustup',
    `no exact2 ${sha.slice(0, 10)} at ~/.exact/exact2/${sha}`,
  ]);
  expect(bare.every((each) => each.commands.length > 0)).toBe(true);

  mkdirSync(join(home, '.bun-1.4.2', 'bin'), { recursive: true });
  script(join(home, '.bun-1.4.2', 'bin', 'bun'), 'echo 1.4.2');
  mkdirSync(join(home, '.cargo', 'bin'), { recursive: true });
  mkdirSync(join(home, '.cargo', 'hermes-lean-sys'));
  script(join(home, '.cargo', 'bin', 'rustup'), 'echo aarch64-apple-darwin');
  const checkout = join(home, '.exact', 'exact2', sha);
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  mkdirSync(join(checkout, 'node_modules'));
  writeFileSync(join(checkout, 'scripts', 'app-cli.mjs'), '');
  expect(exactToolProblems(pins, { HOME: home }).map((each) => each.reason)).toContain(
    `~/.exact/exact2/${sha} is not at commit ${sha.slice(0, 10)}`,
  );
  execFileSync('git', ['clone', '-q', exact2, join(root, 'clone')]);
  execFileSync('mv', [join(root, 'clone', '.git'), join(checkout, '.git')]);
  git(checkout, 'checkout', '-q', '--', '.');
  expect(exactToolProblems(pins, { HOME: home })).toEqual([
    {
      reason: `no Rust 1.97.0 target ${EXACT_SIM_TARGET}`,
      commands: [`rustup target add --toolchain 1.97.0 ${EXACT_SIM_TARGET}`],
    },
  ]);

  script(
    join(home, '.cargo', 'bin', 'rustup'),
    `[ "$RUSTUP_AUTO_INSTALL" = 0 ] || exit 9; printf 'aarch64-apple-darwin\\n${EXACT_SIM_TARGET}\\n'`,
  );
  expect(exactToolProblems(pins, { HOME: home })).toEqual([]);
});

test("doctor finds this Mac's Bun, exact2 and Rust where the app's launcher looks, at or above the pins", () => {
  const home = join(root, 'home');
  const path = join(root, 'path');
  mkdirSync(path);
  const env = { HOME: home, PATH: path };
  expect(exactLocalToolProblems(app, { ...env, EXACT2: join(root, 'missing') }).map((each) => each.reason)).toEqual([
    'no Bun 1.4.2 (exact.mjs runs ~/.bun-1.4.2/bin/bun, else bun on PATH)',
    expect.stringMatching(/^no exact2 checkout at .*missing \(exact.mjs reads EXACT2, else \.\.\/\.\.\/pins\/exact2\)/),
    'no rustup',
  ]);

  script(join(path, 'bun'), 'echo 1.3.9');
  mkdirSync(join(exact2, 'scripts'));
  writeFileSync(join(exact2, 'scripts', 'app-cli.mjs'), '');
  mkdirSync(join(exact2, 'node_modules'));
  mkdirSync(join(home, '.cargo', 'hermes-lean-sys'), { recursive: true });
  script(join(path, 'rustup'), '[ "$RUSTUP_AUTO_INSTALL" = 0 ] || exit 9; echo aarch64-apple-darwin');
  expect(exactLocalToolProblems(app, env)).toEqual([
    {
      reason: `Bun 1.3.9 at ${join(path, 'bun')} is older than the 1.4.2 exact.mjs pins`,
      commands: ['curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun-1.4.2" bash -s "bun-v1.4.2"'],
    },
    {
      reason: `no Rust 1.97.0 target ${EXACT_SIM_TARGET}`,
      commands: [`rustup target add --toolchain 1.97.0 ${EXACT_SIM_TARGET}`],
    },
  ]);

  script(join(path, 'bun'), 'echo 1.5.0');
  writeFileSync(join(app, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.98.0"\n');
  script(
    join(path, 'rustup'),
    `[ "$RUSTUP_AUTO_INSTALL" = 0 ] || exit 9; [ "$5" = 1.98.0 ] && printf '${EXACT_SIM_TARGET}\\n'`,
  );
  expect(exactLocalToolProblems(app, env)).toEqual([]);

  const creator = join(root, "creator's bun");
  writeFileSync(
    join(app, 'exact.mjs'),
    [
      `':' //; if [ -n "$BUN" ]; then exec "$BUN" "$0" "$@"; else exec '${creator.replaceAll("'", "'\\''")}' "$0" "$@"; fi`,
      `const EXACT2 = resolve(import.meta.dir, process.env.EXACT2 ?? "../../pins/exact2");`,
      'ensureBun("1.4.2");',
    ].join('\n'),
  );
  expect(exactLocalToolProblems(app, env).map((each) => each.reason)).toEqual([
    `no Bun 1.4.2 (exact.mjs runs ~/.bun-1.4.2/bin/bun, else ${creator})`,
  ]);
  script(creator, 'echo 1.4.2');
  expect(exactLocalToolProblems(app, env)).toEqual([]);
});

test('doctor asks build machines about the pins only for an Exact app they could build', async () => {
  const context = {
    root: app,
    options: {},
    settings: {},
    optimizations: null,
    platforms: ['ios' as const],
    repoRoot: null,
  };
  const inspect = exactDoctor().offloadTargets?.(context, async () => null);
  expect((await inspect?.())?.map((target) => target.platform === 'ios' && target.exact)).toEqual([
    { exact2: sha, bun: '1.4.2', rust: '1.97.0' },
  ]);
  writeFileSync(join(app, 'app.json'), JSON.stringify({ modules: ['shop-map'] }));
  expect(exactDoctor().offloadTargets?.(context, async () => null)).toBeNull();
});
