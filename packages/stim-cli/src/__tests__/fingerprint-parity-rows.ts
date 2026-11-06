import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

interface MutationContext {
  worktree(root: string): string;
}
export interface MutationRow {
  id: string;
  class: 'must-move' | 'excluded' | 'noise';
  description: string;
  /** An open issue where Stim is known to disagree with the class; the row fails once the disagreement is gone. */
  gap?: string;
  platform?: 'ios';
  applies(root: string): boolean;
  apply?: (root: string) => void;
  env?: (root: string) => NodeJS.ProcessEnv;
  measure?: (root: string, ctx: MutationContext) => { before: string; after: string };
}

export function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'maintenance.auto=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}
export function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function edit(root: string, name: string, change: (value: ReturnType<typeof JSON.parse>) => void): void {
  const path = join(root, name);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}
const appJson = (root: string) =>
  existsSync(join(root, 'app.json')) && !!JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')).expo;
const native = (root: string) => git(root, 'ls-files', '--', 'ios').length > 0;
const always = () => true;
const plugin = (root: string) => {
  if (existsSync(join(root, 'parity-plugin.cjs'))) return './parity-plugin.cjs';
  const config = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')).expo;
  const used = (config.plugins ?? []).map((entry: string | [string, unknown]) =>
    typeof entry === 'string' ? entry : entry[0],
  );
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).find((name) => {
    if (used.includes(name)) return false;
    try {
      createRequire(join(root, 'package.json')).resolve(`${name}/app.plugin.js`);
      return true;
    } catch {
      return false;
    }
  });
};
const configFile = (root: string) =>
  ['app.config.js', 'app.config.ts', 'app.config.cjs'].find((name) => existsSync(join(root, name)));
const envName = (root: string) => {
  const name = configFile(root);
  return name ? (/process\.env\.([A-Z_][A-Z_0-9]*)/.exec(readFileSync(join(root, name), 'utf8'))?.[1] ?? '') : '';
};
const podspec = (root: string) =>
  existsSync(join(root, 'modules'))
    ? (readdirSync(join(root, 'modules'), { recursive: true, encoding: 'utf8' }).find((name) =>
        name.endsWith('.podspec'),
      ) ?? '')
    : '';
const lockfile = (root: string) => {
  for (let dir = root; ; dir = dirname(dir)) {
    const name = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].find((file) => existsSync(join(dir, file)));
    if (name) return join(dir, name);
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return '';
  }
};

function podInstall(root: string): void {
  const lockPath = join(root, 'ios/Podfile.lock');
  let lock = readFileSync(lockPath, 'utf8');
  const entry = /^( {2})([\w.+-]+): [0-9a-f]{40}$/m.exec(lock);
  if (entry) {
    const spec = `${JSON.stringify({ name: entry[2], source: { path: root } })}\n`;
    write(join(root, `ios/Pods/Local Podspecs/${entry[2]}.podspec.json`), spec);
    lock = lock.replace(entry[0], `${entry[1]}${entry[2]}: ${createHash('sha1').update(spec).digest('hex')}`);
  }
  write(lockPath, lock);
  write(join(root, 'ios/Pods/Manifest.lock'), lock);
  write(join(root, 'ios/Parity.xcworkspace/contents.xcworkspacedata'), `<Workspace location="${root}"/>\n`);
}

export const rows: MutationRow[] = [
  {
    id: 'config-plugin-input',
    class: 'must-move',
    platform: 'ios',
    description: 'a native config field consumed by an iOS config plugin',
    applies: appJson,
    apply: (root) =>
      edit(root, 'app.json', ({ expo }) => {
        expo.ios ??= {};
        expo.ios.infoPlist ??= {};
        expo.ios.infoPlist.StimParity = 'changed';
      }),
  },
  {
    id: 'plugin-added',
    class: 'must-move',
    description: 'adding a config plugin',
    applies: (root) => appJson(root) && !!plugin(root),
    apply: (root) =>
      edit(root, 'app.json', ({ expo }) => {
        expo.plugins = [...(expo.plugins ?? []), plugin(root)];
      }),
  },
  {
    id: 'swift',
    platform: 'ios',
    class: 'must-move',
    description: 'a Swift source added under tracked ios',
    applies: native,
    apply: (root) => write(join(root, 'ios/Parity.swift'), 'let parity = 2\n'),
  },
  {
    id: 'patch',
    class: 'must-move',
    description: 'a patch-package native patch',
    applies: always,
    apply: (root) =>
      write(
        join(root, 'patches/parity+1.0.0.patch'),
        'diff --git a/ios/Parity.swift b/ios/Parity.swift\n--- a/ios/Parity.swift\n+++ b/ios/Parity.swift\n@@ -1 +1 @@\n-let parity = 1\n+let parity = 2\n',
      ),
  },
  {
    id: 'config-env',
    class: 'must-move',
    description: 'an environment variable read by app config',
    applies: (root) => !!envName(root),
    env: (root) => ({ [envName(root)]: `${process.env[envName(root)] ?? ''}parity-changed` }),
  },
  {
    id: 'manifest-native',
    class: 'must-move',
    description: 'manifest autolinking settings exclude an installed native package',
    applies: (root) => {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      return (
        !!manifest.dependencies?.['expo-constants'] && !manifest.expo?.autolinking?.exclude?.includes('expo-constants')
      );
    },
    apply: (root) =>
      edit(root, 'package.json', (manifest) => {
        manifest.expo ??= {};
        manifest.expo.autolinking ??= {};
        manifest.expo.autolinking.exclude = [...(manifest.expo.autolinking.exclude ?? []), 'expo-constants'];
      }),
  },
  {
    id: 'local-podspec',
    platform: 'ios',
    class: 'must-move',
    description: 'a local native module podspec changes',
    applies: (root) => !!podspec(root),
    apply: (root) => {
      const path = join(root, 'modules', podspec(root));
      write(path, `${readFileSync(path, 'utf8')}\nPod::UI.puts 'parity-changed'\n`);
    },
  },
  {
    id: 'versions',
    class: 'excluded',
    description: 'all five app version fields stay outside the native key',
    gap: '#5334',
    applies: appJson,
    apply: (root) =>
      edit(root, 'app.json', ({ expo }) => {
        expo.version = '2.0.0';
        expo.ios = { ...expo.ios, version: '2.0.0', buildNumber: '42' };
        expo.android = { ...expo.android, version: '2.0.0', versionCode: 42 };
      }),
  },
  {
    id: 'eas',
    class: 'excluded',
    description: 'EAS build profiles do not affect local native builds',
    applies: always,
    apply: (root) => write(join(root, 'eas.json'), '{"build":{"parity":{"distribution":"internal"}}}\n'),
  },
  {
    id: 'lockfile',
    class: 'excluded',
    description: 'a lockfile refresh preserves installed native dependencies',
    applies: (root) => !!lockfile(root),
    apply: (root) => {
      const path = lockfile(root);
      write(path, `${readFileSync(path, 'utf8')}\n`);
    },
  },
  {
    id: 'js',
    class: 'noise',
    description: 'a Metro source edit',
    applies: always,
    apply: (root) => write(join(root, 'parity-source.js'), 'export const parity = 2;\n'),
  },
  {
    id: 'empty-commit',
    class: 'noise',
    description: 'a commit with no content change',
    applies: always,
    apply: (root) => {
      git(
        root,
        '-c',
        'user.name=Parity',
        '-c',
        'user.email=parity@example.com',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'empty',
      );
    },
  },
  {
    id: 'metro-cache',
    class: 'noise',
    description: 'Metro writes its Expo cache',
    applies: always,
    apply: (root) => write(join(root, '.expo/parity/cache'), 'cache\n'),
  },
  {
    id: 'xcuserdata',
    platform: 'ios',
    class: 'noise',
    description: 'Xcode writes user data under ios',
    applies: native,
    apply: (root) =>
      write(join(root, 'ios/Parity.xcodeproj/xcuserdata/parity.xcuserdatad/UserInterfaceState.xcuserstate'), 'state\n'),
  },
  {
    id: 'worktree',
    class: 'noise',
    description: 'the same tree in a fresh worktree',
    applies: always,
    measure: (root, ctx) => ({ before: root, after: ctx.worktree(root) }),
  },
  {
    id: 'pod-install-in-worktree',
    platform: 'ios',
    class: 'noise',
    description: 'pod install rewrites checkout paths and generated files in a fresh worktree',
    applies: (root) => native(root) && !!git(root, 'ls-files', '--', 'ios/Podfile.lock'),
    measure: (root, ctx) => {
      const after = ctx.worktree(root);
      podInstall(root);
      podInstall(after);
      return { before: root, after };
    },
  },
];

export function verdict(
  row: MutationRow,
  { expoMoved, stimMoved }: { expoMoved?: boolean; stimMoved: boolean },
): { ok: boolean; label: string } {
  if (row.gap) {
    return stimMoved
      ? { ok: true, label: `known gap ${row.gap}` }
      : { ok: false, label: `gap ${row.gap} is closed: remove the gap marker` };
  }
  if (row.class === 'noise' && expoMoved) {
    return stimMoved
      ? { ok: false, label: 'unexpected Stim movement' }
      : { ok: true, label: 'oracle noise; stim stable' };
  }
  if (stimMoved !== (row.class === 'must-move'))
    return { ok: false, label: stimMoved ? 'unexpected Stim movement' : 'Stim did not move' };
  if (row.class === 'must-move' && expoMoved === false) return { ok: false, label: 'expo did not move' };
  if (row.class === 'excluded' && expoMoved === false)
    return { ok: true, label: 'expo did not move; stim did not move' };
  return { ok: true, label: row.class === 'excluded' && expoMoved ? 'expected exclusion' : 'ok' };
}
