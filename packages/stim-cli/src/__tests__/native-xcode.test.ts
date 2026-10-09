import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectRegistry } from '../integrations/projects.ts';
import { selectNativeXcodeProject } from '../integrations/native-xcode-project.ts';
import { nativeXcodeInputSnapshot } from '../integrations/native-xcode-inputs.ts';
import { nativeXcodeIosProject } from '../integrations/native-xcode-ios.ts';
import { setExecutor, resetExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';
import { resolveOptimizations } from '../optimizations.ts';
import { writeNativeXcodeProject } from './_native-xcode-project.ts';

let root: string;
let home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-xcode-')));
  home = mkdtempSync(join(tmpdir(), 'stim-native-xcode-home-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function write(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function fingerprint() {
  return nativeXcodeInputSnapshot(root, selectNativeXcodeProject(root), {
    sdk: 'iphonesimulator',
    architecture: 'arm64',
    toolchain: { xcode: 'Xcode 26.0 build 17A', sdk: '26.0' },
    optimizations: resolveOptimizations({}, {}).ios,
  });
}

test('production discovery selects a native application without Node or Metro and exposes each build configuration', async () => {
  writeNativeXcodeProject(root);
  setExecutor(
    makeExecutor({
      runFile: () => {
        throw new Error('Discovery must not launch an external tool');
      },
    }),
  );
  expect(projectRegistry.findProjectRoot(root)).toBe(root);
  expect(projectRegistry.detectPlatforms(root, {})).toEqual(['ios']);
  expect(projectRegistry.projectProblem(root, 'ios')).toBeNull();
  expect(projectRegistry.projectProblem(root, 'dev-server')?.kind).toBe('not-an-app');
  for (const configuration of ['Debug', 'Release', 'Staging']) {
    const selected = selectNativeXcodeProject(root, undefined, configuration);
    expect(selected).toMatchObject({ scheme: 'Native', targetName: 'Native', configuration });
    const runtime = nativeXcodeIosProject(root).runtime({
      configuration,
      prepareMetro: async () => {
        throw new Error('Metro must not be prepared');
      },
      prepareEmbedded: async () => {
        throw new Error('JS must not be embedded');
      },
    });
    expect(runtime.kind).toBe('process');
    expect(await runtime.prepare()).toEqual({ ok: true, prepared: { metroPort: null } });
  }
  expect(nativeXcodeIosProject(root).schemeProblem(undefined, 'Missing')?.code).toBe('STIM_BAD_ARG');
});

test('a workspace owns its referenced project instead of competing with it', () => {
  writeNativeXcodeProject(root);
  write(
    join(root, 'Native.xcworkspace', 'contents.xcworkspacedata'),
    '<Workspace><FileRef location="group:Native.xcodeproj" /></Workspace>',
  );
  expect(selectNativeXcodeProject(root)).toMatchObject({
    container: { flag: '-workspace', path: join(root, 'Native.xcworkspace') },
    scheme: 'Native',
  });
});

test('several application containers require an exact scheme and a missing scheme never guesses', () => {
  writeNativeXcodeProject(root);
  writeNativeXcodeProject(root, 'Another');
  expect(() => selectNativeXcodeProject(root)).toThrow('ambiguous');
  expect(selectNativeXcodeProject(root, 'Another').targetName).toBe('Another');
  expect(() => selectNativeXcodeProject(root, 'Missing')).toThrow('No runnable');
});

test('macOS applications and libraries do not become runnable iOS projects', () => {
  writeNativeXcodeProject(root, 'Desktop', 'macosx');
  writeNativeXcodeProject(root, 'Library', 'iphoneos', 'framework');
  expect(projectRegistry.projectProblem(root, 'ios')?.kind).toBe('not-an-app');
  expect(projectRegistry.detectPlatforms(root, {})).toEqual([]);
});

test('an unreadable native project refuses and a valid RN app retains ownership of its generated child', () => {
  const ios = join(root, 'ios');
  mkdirSync(ios);
  const project = writeNativeXcodeProject(ios);
  writeFileSync(join(project, 'project.pbxproj'), 'broken project');
  expect(projectRegistry.projectProblem(ios, 'ios')?.kind).toBe('unreadable');
  write(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
  expect(projectRegistry.findProjectRoot(ios)).toBe(root);
  expect(projectRegistry.projectProblem(root, 'ios')).toBeNull();
});

test('source, ignored resources and build settings invalidate native reuse', () => {
  const project = writeNativeXcodeProject(root);
  write(join(root, '.gitignore'), 'Assets/ignored.bin\n');
  write(join(root, 'Assets', 'ignored.bin'), 'one');
  const before = fingerprint();
  expect(before).not.toHaveProperty('cacheIneligible');
  write(join(root, 'Assets', 'ignored.bin'), 'two');
  const asset = fingerprint();
  expect(asset).not.toEqual(before);
  write(join(root, 'Native.swift'), 'struct DifferentApp {}');
  const source = fingerprint();
  expect(source).not.toEqual(asset);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(pbx, readFileSync(pbx, 'utf8').replaceAll('org.example.Native', 'org.example.Other'));
  expect(fingerprint()).not.toEqual(source);
});

test('a referenced source outside the application participates in native identity', () => {
  const app = join(root, 'App');
  mkdirSync(app);
  const project = writeNativeXcodeProject(app);
  const external = join(root, 'External.swift');
  writeFileSync(external, 'struct External {}');
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(pbx, readFileSync(pbx, 'utf8').replace('path = Native.swift;', 'path = ../External.swift;'));
  const snapshot = () =>
    nativeXcodeInputSnapshot(app, selectNativeXcodeProject(app), {
      sdk: 'iphonesimulator',
      architecture: 'arm64',
      toolchain: {},
      optimizations: {},
    });
  const before = snapshot();
  expect(before).not.toHaveProperty('cacheIneligible');
  writeFileSync(external, 'struct ExternalChanged {}');
  expect(snapshot()).not.toEqual(before);
});

test('repository inputs outside the application and unresolved C-family include graphs cannot produce stale hits', () => {
  const app = join(root, 'App');
  mkdirSync(app);
  const project = writeNativeXcodeProject(app);
  write(join(root, 'Shared', 'Resource.bin'), 'one');
  const snapshot = () =>
    nativeXcodeInputSnapshot(
      app,
      selectNativeXcodeProject(app),
      {
        sdk: 'iphonesimulator',
        architecture: 'arm64',
        toolchain: {},
        optimizations: {},
      },
      root,
    );
  const before = snapshot();
  expect(before).not.toHaveProperty('cacheIneligible');
  write(join(root, 'Shared', 'Resource.bin'), 'two');
  expect(snapshot()).not.toEqual(before);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(pbx, readFileSync(pbx, 'utf8').replace('path = Native.swift;', 'path = Native.m;'));
  write(join(app, 'Native.m'), '#include "../../Outside.h"\n');
  expect(snapshot()).toMatchObject({ cacheIneligible: expect.stringContaining('compiler include dependency graph') });
});

test('an unbounded build script is explicitly cache-ineligible rather than assigned an artifact key', () => {
  const project = writeNativeXcodeProject(root);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8').replace(
      'objects = {',
      'objects = {\nSCRIPT = { isa = PBXShellScriptBuildPhase; shellScript = "date > generated.swift"; };',
    ),
  );
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('undeclared inputs') });
});

test('synchronized source groups inventory their files and refuse unresolved C includes', () => {
  const project = writeNativeXcodeProject(root);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8').replace(
      'GROUP = { isa = PBXGroup; children = ( SOURCE, ); sourceTree = "<group>"; };',
      'GROUP = { isa = PBXFileSystemSynchronizedRootGroup; path = Sources; sourceTree = "<group>"; };',
    ),
  );
  write(join(root, 'Sources', 'App.swift'), 'struct NativeApp {}');
  const before = fingerprint();
  expect(before).not.toHaveProperty('cacheIneligible');
  write(join(root, 'Sources', 'App.swift'), 'struct UpdatedApp {}');
  expect(fingerprint()).not.toEqual(before);
  write(join(root, 'Sources', 'Native.m'), '#include "/external/input.h"\n');
  expect(fingerprint()).toMatchObject({
    cacheIneligible: expect.stringContaining('compiler include dependency graph'),
  });
});

test('scheme execution actions cannot be skipped by an artifact cache hit', () => {
  const project = writeNativeXcodeProject(root);
  const scheme = join(project, 'xcshareddata', 'xcschemes', 'Native.xcscheme');
  writeFileSync(
    scheme,
    readFileSync(scheme, 'utf8').replace(
      '</Scheme>',
      '<BuildAction><PreActions><ExecutionAction ActionType="Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction"><ActionContent scriptText="date > generated.swift" /></ExecutionAction></PreActions></BuildAction></Scheme>',
    ),
  );
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('scheme execution actions') });
});

test('relocation, shell location and task metadata preserve warm identities while compiler environment changes do not', () => {
  writeNativeXcodeProject(root);
  const before = fingerprint();
  expect(before).not.toHaveProperty('cacheIneligible');
  for (const name of ['PWD', 'OLDPWD', 'TMPDIR', 'SHLVL', '_', 'STIM_QA_TASK_ID']) vi.stubEnv(name, `changed-${name}`);
  expect(fingerprint()).toEqual(before);
  const relocated = join(home, 'relocated');
  cpSync(root, relocated, { recursive: true });
  expect(
    nativeXcodeInputSnapshot(relocated, selectNativeXcodeProject(relocated), {
      sdk: 'iphonesimulator',
      architecture: 'arm64',
      toolchain: { xcode: 'Xcode 26.0 build 17A', sdk: '26.0' },
      optimizations: resolveOptimizations({}, {}).ios,
    }),
  ).toEqual(before);
  vi.stubEnv('CFLAGS', '-DNATIVE_FEATURE=1');
  expect(fingerprint()).not.toEqual(before);
  vi.stubEnv('CFLAGS', '-include external.h');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('CFLAGS') });
  vi.stubEnv('CFLAGS', '');
  vi.stubEnv('CPATH', '/unresolved/external/headers');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('CPATH') });
});

test('local Swift packages do not get a partial key that omits their transitive dependencies', () => {
  const project = writeNativeXcodeProject(root);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8').replace(
      'objects = {',
      'objects = {\nPACKAGE = { isa = XCLocalSwiftPackageReference; relativePath = Packages/Local; };',
    ),
  );
  write(join(root, 'Packages', 'Local', 'Package.swift'), 'import PackageDescription\n');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('transitive local dependencies') });
});

test('native planning refuses unresolved source closure without dependency preparation or builds', async () => {
  const project = writeNativeXcodeProject(root);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8').replace(
      'objects = {',
      'objects = {\nSCRIPT = { isa = PBXShellScriptBuildPhase; shellScript = "date"; };',
    ),
  );
  const commands: string[][] = [];
  setExecutor(
    makeExecutor({
      runFile(file, args = []) {
        commands.push([file, ...args]);
        return 'Tool identity';
      },
      spawn() {
        throw new Error('Planning must not spawn dependency preparation or compilation');
      },
    }),
  );
  const plan = await nativeXcodeIosProject(root).plan!({});
  expect(plan).toMatchObject({
    refusal: { code: 'STIM_BAD_ARG', message: expect.stringContaining('undeclared inputs') },
  });
  expect(commands.some((command) => command.includes('-resolvePackageDependencies') || command.includes('build'))).toBe(
    false,
  );
});
