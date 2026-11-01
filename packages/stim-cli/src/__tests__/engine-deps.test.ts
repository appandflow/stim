import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { DEPS_ERROR, extractPodDiagnostics, runPodInstall, parseLoginRubyEnv, podEnvForRuby } from '../engine/deps.ts';
import { makeChildProcess, makeError, makeWriter } from './_factories.ts';

type WriteRecord = { src: string; level: string; msg: string };

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-deps-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakePodChild({
  lines = [],
  code = 0,
  signal = null,
  error = null,
}: {
  lines?: string[];
  code?: number;
  signal?: NodeJS.Signals | null;
  error?: Error | null;
} = {}) {
  const child = makeChildProcess({ pid: 4242 });
  setImmediate(() => {
    for (const line of lines) child.stdout?.emit('data', `${line}\n`);
    if (error) child.emit('error', error);
    else child.emit('exit', code, signal);
  });
  return child;
}

function collectingWriter() {
  const records: WriteRecord[] = [];
  const writer = makeWriter({
    write: (r: WriteRecord) => {
      records.push(r);
      return true;
    },
  });
  return Object.assign(writer, { records });
}

describe('podEnvForRuby (#43, #44)', () => {
  test("uses rvm's default Ruby without reading the login shell when the project pins none", () => {
    const rvm = join('/home/u', '.rvm');
    const gems = join(rvm, 'gems', 'ruby-3.4.8');
    const ruby = join(rvm, 'rubies', 'ruby-3.4.8', 'bin');
    const env = podEnvForRuby(null, {
      env: { PATH: '/usr/bin' },
      home: '/home/u',
      exists: (p) => p === ruby || p === join(gems, 'bin'),
      read: (p) => (p === join(rvm, 'config', 'alias') ? 'default=ruby-3.4.8\n' : null),
      loginEnv: () => {
        throw new Error('login shell must not be read when rvm names a default Ruby');
      },
    });
    expect(env.PATH).toBe([join(gems, 'bin'), ruby, '/usr/bin'].join(delimiter));
    expect(env.GEM_HOME).toBe(gems);
    expect(env.GEM_PATH).toBe([gems, `${gems}@global`].join(delimiter));
  });

  describe.skipIf(process.platform === 'win32')('login-shell Ruby, read only on darwin', () => {
    test('keeps the caller PATH order and adds only login Ruby directories it lacks', () => {
      const login = { PATH: '/usr/bin:/gems/bin:/opt/ruby/bin:/usr/local/bin', GEM_HOME: '/gems' };
      const env = podEnvForRuby(null, {
        env: { PATH: '/agent/bin:/usr/local/bin:/usr/bin' },
        home: '/home/u',
        exists: (p) => p === '/usr/bin/ruby' || p === '/opt/ruby/bin/ruby' || p === '/usr/local/bin/pod',
        loginEnv: () => login,
      });
      expect(env.PATH).toBe(['/gems/bin', '/opt/ruby/bin', '/agent/bin', '/usr/local/bin', '/usr/bin'].join(delimiter));
    });
  });

  test('parseLoginRubyEnv ignores shell banners and empty values', () => {
    const out = 'motd\n\n@@ruby-env-begin@@\nPATH=/a:/b\nGEM_HOME=\nGEM_PATH=/g\n@@ruby-env-end@@\n';
    expect(parseLoginRubyEnv(out)).toEqual({ PATH: '/a:/b', GEM_PATH: '/g' });
    expect(parseLoginRubyEnv('nothing here')).toBeNull();
    expect(parseLoginRubyEnv('@@ruby-env-begin@@\nPATH=/a\n')).toBeNull();
  });
});

describe('runPodInstall', () => {
  test("a `pods` heartbeat carries this project's last pod install when stats have one", async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const beats: string[] = [];
    const child = makeChildProcess({ pid: 4243 });
    const pending = runPodInstall(root, collectingWriter(), {
      spawnFn: () => {
        setTimeout(() => child.emit('exit', 0, null), 120);
        return child;
      },
      heartbeatMs: 25,
      estimateMs: 100_000,
      onHeartbeat: (l: string) => beats.push(l),
    });
    await vi.advanceTimersByTimeAsync(120);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(beats[0]).toMatch(/^ {2}pods\s+still installing \(\d+s of ~1m40s\)$/);
  });

  test('an ENOENT delivered as a spawn `error` event is recognized the same way', async () => {
    mkdirSync(join(root, 'ios'), { recursive: true });
    const err = makeError('spawn pod ENOENT', { code: 'ENOENT' });
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => fakePodChild({ error: err }),
    });
    expect(result.reason).toMatch(/CocoaPods is not installed/);
  });
});

describe('runPodInstall build configuration markers (#4377)', () => {
  const MARKER = '.last_build_configuration';
  const markerPath = (pod: string) => join(root, 'ios', 'Pods', pod, MARKER);

  function installPod(pod: string, marker: string | null) {
    mkdirSync(join(root, 'ios', 'Pods', pod, 'React.xcframework'), { recursive: true });
    if (marker !== null) writeFileSync(markerPath(pod), marker);
  }

  test('puts the marker back when pod install fails after cleaning', async () => {
    installPod('React-Core-prebuilt', 'Release');
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: () => {
        rmSync(markerPath('React-Core-prebuilt'));
        return fakePodChild({ code: 1 });
      },
    });
    expect(result.failed).toBe(true);
    expect(readFileSync(markerPath('React-Core-prebuilt'), 'utf-8')).toBe('Release');
  });
});

describe('runPodInstall through bundler (#137)', () => {
  const COCOAPODS_LOCK = [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    activesupport (7.2.3.2)',
    '    cocoapods (1.15.2)',
    '      cocoapods-core (= 1.15.2)',
    '    cocoapods-core (1.15.2)',
    '',
    'DEPENDENCIES',
    '  cocoapods (~> 1.15)',
    '',
  ].join('\n');

  function pinnedProject({ lock = COCOAPODS_LOCK, at = '.' }: { lock?: string | null; at?: string } = {}) {
    mkdirSync(join(root, 'ios'), { recursive: true });
    writeFileSync(join(root, at, 'Gemfile'), "source 'https://rubygems.org'\ngem 'cocoapods'\n");
    if (lock !== null) writeFileSync(join(root, at, 'Gemfile.lock'), lock);
  }

  function router(
    calls: SpawnCall[],
    replies: Record<string, () => ReturnType<typeof fakePodChild>>,
  ): (cmd: string, args: string[], opts: Record<string, unknown>) => ReturnType<typeof fakePodChild> {
    return (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const key = [cmd, ...args].join(' ');
      const reply = replies[key];
      if (!reply) throw new Error(`unexpected spawn: ${key}`);
      return reply();
    };
  }

  const ok = () => fakePodChild({ lines: ['Pod installation complete!'] });

  test('bundler never gets to write the lockfile: --dry-run on check, BUNDLE_FROZEN on every spawn', async () => {
    pinnedProject();
    const calls: SpawnCall[] = [];
    await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, {
        'bundle check --dry-run': () => fakePodChild({ code: 1, lines: ['The following gems are missing'] }),
        'bundle install': ok,
        'bundle exec pod install': ok,
      }),
    });
    expect(calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual([
      'bundle check --dry-run',
      'bundle install',
      'bundle exec pod install',
    ]);
    for (const call of calls) {
      const env = call.opts.env as NodeJS.ProcessEnv;
      expect(env.BUNDLE_FROZEN).toBe('true');
      expect(env.BUNDLE_GEMFILE).toBe(join(root, 'Gemfile'));
      expect(env.FORCE_COLOR).toBe('0');
      expect(env.CLICOLOR).toBe('0');
    }
  });

  test('no `bundle` on PATH falls back to plain `pod install` with a note, not a failure', async () => {
    pinnedProject();
    const calls: SpawnCall[] = [];
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (cmd === 'bundle') throw makeError('spawn bundle ENOENT', { code: 'ENOENT' });
        return ok();
      },
    });
    expect(result.ok).toBe(true);
    expect(result.command).toBe('pod install');
    expect(result.failed).toBe(undefined);
    expect(result.notes?.join('\n')).toMatch(/`bundle` is not on PATH/);
    expect(calls.map((c) => c.cmd)).toEqual(['bundle', 'pod']);
    const podEnvOnly = calls[1]?.opts.env as NodeJS.ProcessEnv;
    expect(podEnvOnly.BUNDLE_FROZEN).toBe(undefined);
    expect(podEnvOnly.BUNDLE_GEMFILE).toBe(undefined);
  });

  test('a failed `bundle install` fails the run with STIM_DEPS_FAILED and never runs pods', async () => {
    pinnedProject();
    writeFileSync(join(root, '.ruby-version'), 'ruby-3.4.1\n');
    const calls: SpawnCall[] = [];
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router(calls, {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': () =>
          fakePodChild({ code: 5, lines: ["Could not find gem 'activesupport (= 7.1.3)' in locally installed gems."] }),
      }),
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(DEPS_ERROR);
    expect(result.reason).toMatch(/`bundle install` failed \(exit code 5\)/);
    expect(result.remedy).toMatch(/ruby 3\.4\.1/);
    expect(result.remedy).toMatch(/bundle install/);
    assert(result.lastLines);
    expect(result.lastLines.join('\n')).toMatch(/Could not find gem/);
    expect(calls.map((c) => c.cmd)).toEqual(['bundle', 'bundle']);
  });

  test('a frozen-mode refusal from `bundle exec pod install` gets the same remedy', async () => {
    pinnedProject();
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ lines: ['satisfied'] }),
        'bundle exec pod install': () =>
          fakePodChild({
            code: 1,
            lines: [
              "definition.rb:469:in 'ensure_equivalent_gemfile_and_lockfile': the lockfile can't be updated because frozen mode is set (Bundler::ProductionError)",
            ],
          }),
      }),
    });
    expect(result.failed).toBe(true);
    expect(result.command).toBe('bundle exec pod install');
    expect(result.reason).toMatch(/`bundle exec pod install` failed \(exit code 1\)/);
    expect(result.remedy).toMatch(/BUNDLE_FROZEN/);
  });

  test('a bundle without the pinned pod binary points at the bundle that is actually loaded', async () => {
    pinnedProject();
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ lines: ['satisfied'] }),
        'bundle exec pod install': () =>
          fakePodChild({
            code: 1,
            lines: [
              "can't find executable pod for gem cocoapods. cocoapods is not currently included in the bundle, perhaps you meant to add it to your Gemfile? (Gem::Exception)",
            ],
          }),
      }),
    });
    expect(result.failed).toBe(true);
    expect(result.remedy).toMatch(/resolves cocoapods/);
    expect(result.remedy).toMatch(/belong to a different Gemfile/);
    expect(result.remedy).toMatch(/bundle exec pod --version/);
    expect(result.remedy).not.toMatch(/remove .*Gemfile\.lock/);
  });

  test('an ENOENT at the pod step in the bundler branch names `bundle`, not CocoaPods', async () => {
    pinnedProject();
    const result = await runPodInstall(root, collectingWriter(), {
      spawnFn: (_cmd, args) => {
        if (args[0] === 'check') return fakePodChild({ lines: ['satisfied'] });
        throw makeError('spawn bundle ENOENT', { code: 'ENOENT' });
      },
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(DEPS_ERROR);
    expect(result.reason).toMatch(/Bundler is not installed/);
    expect(result.reason).not.toMatch(/CocoaPods is not installed/);
    expect(result.remedy).toMatch(/gem install bundler/);
  });

  test('`bundle install` reports the project-local BUNDLE_PATH it filled, and only that', async () => {
    pinnedProject();
    mkdirSync(join(root, '.bundle'), { recursive: true });
    writeFileSync(join(root, '.bundle', 'config'), 'BUNDLE_PATH: "vendor/bundle"\nBUNDLE_FORCE_RUBY_PLATFORM: 1\n');
    const withPath = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': ok,
        'bundle exec pod install': ok,
      }),
    });
    expect(withPath.notes?.join('\n')).toContain(`gems in ${join('vendor', 'bundle')}${sep}`);
    expect(withPath.notes?.join('\n')).toMatch(/Gemfile\.lock itself is never written/);

    writeFileSync(join(root, '.bundle', 'config'), 'BUNDLE_PATH: "/opt/gems"\n');
    const outside = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': ok,
        'bundle exec pod install': ok,
      }),
    });
    expect(outside.notes).toEqual([]);

    writeFileSync(join(root, '.bundle', 'config'), 'BUNDLE_PATH: "~/gems-probe"\n');
    const home = await runPodInstall(root, collectingWriter(), {
      spawnFn: router([], {
        'bundle check --dry-run': () => fakePodChild({ code: 1 }),
        'bundle install': ok,
        'bundle exec pod install': ok,
      }),
    });
    expect(home.notes).toEqual([]);
  });
});

describe('extractPodDiagnostics', () => {
  test('a resolver conflict block is captured whole, generic advice excluded (case 3)', () => {
    const block = [
      '[!] CocoaPods could not find compatible versions for pod "GoogleUtilities":',
      '  In snapshot (Podfile.lock):',
      '    GoogleUtilities (= 13.6.1)',
      '  In Podfile:',
      '    FirebaseCoreInternal was resolved to 9.6.0, which depends on',
      '      GoogleUtilities (= 13.6.3)',
    ];
    const transcript = [
      'Analyzing dependencies',
      ...block,
      '',
      'You have either:',
      ' * out-of-date source repos which you can update with `pod repo update` or with `pod install --repo-update`.',
      ' * changed the constraints of dependency `GoogleUtilities` inside your development pod.',
    ].join('\n');
    const extracted = extractPodDiagnostics(transcript);
    assert(extracted);
    expect(extracted.source).toBe('cocoapods');
    expect(extracted.lines).toEqual(block);
  });

  test('a Ruby crash extracts the exception head and its prologue, never the frames (case 2)', () => {
    const rubyRoot = '/opt/homebrew/Cellar/ruby/3.4.1/lib/ruby/3.4.0';
    const transcript = [
      'Could not find proper version of cocoapods (1.15.2) in any of the sources',
      'Run `bundle install` to install missing gems.',
      `${rubyRoot}/rubygems/specification.rb:1408:in 'Gem::Specification.gem': Could not find 'minitest' (>= 5.1) among 81 total gem(s) (Gem::MissingSpecError)`,
      `\tfrom ${rubyRoot}/rubygems.rb:239:in 'block in Gem.find_and_activate_spec_for_exe'`,
      `\tfrom ${rubyRoot}/rubygems.rb:238:in 'Thread::Mutex#synchronize'`,
      `\tfrom ${rubyRoot}/rubygems.rb:238:in 'Gem.find_and_activate_spec_for_exe'`,
      `\tfrom ${rubyRoot}/rubygems.rb:282:in 'Gem.activate_and_load_bin_path'`,
      "\tfrom /opt/homebrew/bin/pod:25:in '<main>'",
    ].join('\n');
    const extracted = extractPodDiagnostics(transcript);
    assert(extracted);
    expect(extracted.source).toBe('ruby');
    expect(extracted.lines).toEqual([
      'Could not find proper version of cocoapods (1.15.2) in any of the sources',
      'Run `bundle install` to install missing gems.',
      `${rubyRoot}/rubygems/specification.rb:1408:in 'Gem::Specification.gem': Could not find 'minitest' (>= 5.1) among 81 total gem(s) (Gem::MissingSpecError)`,
    ]);
  });

  test('the cap falls on the warnings at the end, never the error at the front', () => {
    const transcript = [
      '[!] The one line that matters',
      ...Array.from({ length: 20 }, (_, i) => `[!] [Expo] package-${i} was not linked: requires iOS 16.4`),
    ].join('\n');
    const extracted = extractPodDiagnostics(transcript);
    assert(extracted);
    expect(extracted.lines).toHaveLength(16);
    expect(extracted.lines[0]).toBe('[!] The one line that matters');
    expect(extracted.lines[15]).toBe('(+6 more [!] lines in the build log)');
  });
});
