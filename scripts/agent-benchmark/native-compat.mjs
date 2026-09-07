import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assets = fileURLToPath(new URL('./compat/', import.meta.url));
const originalHostHash = '773018741804be5685becd296431c3f77f4fad7a22a7e88ce154d51a99d98e13';
const originalJsiHash = '7f9c3901859a395b628fb7f0c9d59c594ecad61f422de1e41b6583a8667dabe2';
const jsiRelative = 'node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh';

export function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function packageHash(path) {
  const hash = createHash('sha256');
  function visit(directory) {
    for (const name of readdirSync(directory).toSorted()) {
      const entry = join(directory, name);
      const stat = lstatSync(entry);
      if (stat.isDirectory()) visit(entry);
      else if (stat.isFile()) hash.update(JSON.stringify([relative(path, entry), stat.mode & 0o777, fileHash(entry)]));
      else if (stat.isSymbolicLink()) {
        const link = readlinkSync(entry);
        const target = relative(realpathSync(path), realpathSync(entry));
        if (isAbsolute(link) || target === '..' || target.startsWith('../'))
          throw new Error('compatibility package symlink escapes its package');
        hash.update(JSON.stringify([relative(path, entry), 'symlink', link]));
      } else throw new Error(`compatibility package contains an unsupported entry: ${relative(path, entry)}`);
    }
  }
  visit(path);
  return hash.digest('hex');
}

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('compatibility patch does not match exactly once');
  return text.replace(before, after);
}

export function patchedHostProcess(text) {
  let output = replaceOnce(
    text,
    'const r=1e3,i=process.platform===`win32`?`ps`:`/bin/ps`;',
    'import{fileURLToPath as compatPath}from"node:url";const r=1e3,i=process.platform===`darwin`?compatPath(new URL("./ps-bridge.mjs",import.meta.url)):process.platform===`win32`?`ps`:`/bin/ps`;',
  );
  output = replaceOnce(
    output,
    'e(`ps`,[`-p`,i.join(`,`),`-o`,`pid=,state=,lstart=`]',
    'e(process.platform===`darwin`?compatPath(new URL("./ps-bridge.mjs",import.meta.url)):`ps`,[`-p`,i.join(`,`),`-o`,`pid=,state=,lstart=`]',
  );
  return output;
}

export function patchedJsiBuild(text) {
  if (text.includes('-disable-sandbox') || text.includes('-IDEPackageSupportDisable'))
    throw new Error('ExpoModulesJSI compatibility patch is already present');
  let output = replaceOnce(
    text,
    'xcodebuild \\\n',
    'xcodebuild \\\n  -IDEPackageSupportDisableManifestSandbox=1 \\\n  -IDEPackageSupportDisablePluginExecutionSandbox=1 \\\n',
  );
  return replaceOnce(
    output,
    'SWIFT_COMPILATION_MODE=wholemodule \\\n',
    "SWIFT_COMPILATION_MODE=wholemodule \\\n  'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox' \\\n",
  );
}

export function prepareNativeCompatibility({
  destination,
  agentDevicePackage,
  nativeSource,
  expectedNativeSourceSha256,
  sourceCommit,
  fixture,
}) {
  destination = resolve(destination);
  if (existsSync(destination)) throw new Error('compatibility destination must be new');
  const metadata = JSON.parse(readFileSync(join(agentDevicePackage, 'package.json'), 'utf8'));
  if (metadata.version !== '0.20.10') throw new Error('compatibility patch requires agent-device 0.20.10');
  const originalHost = join(agentDevicePackage, 'dist/src/host-process.js');
  if (fileHash(originalHost) !== originalHostHash) throw new Error('agent-device host-process base hash mismatch');
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('native helper source commit must be exact');
  if (fileHash(nativeSource) !== expectedNativeSourceSha256) throw new Error('native helper source hash mismatch');
  const sourceRepository = execFileSync('git', ['-C', dirname(nativeSource), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  const committedSource = execFileSync(
    'git',
    ['-C', sourceRepository, 'show', `${sourceCommit}:${relative(sourceRepository, nativeSource)}`],
    { timeout: 10_000 },
  );
  if (createHash('sha256').update(committedSource).digest('hex') !== expectedNativeSourceSha256)
    throw new Error('native helper does not match its declared source commit');
  const jsi = join(fixture, jsiRelative);
  if (fileHash(jsi) !== originalJsiHash) throw new Error('ExpoModulesJSI base hash mismatch');
  const patchedHost = patchedHostProcess(readFileSync(originalHost, 'utf8'));
  const patchedJsi = patchedJsiBuild(readFileSync(jsi, 'utf8'));
  const originalPackageSha256 = packageHash(agentDevicePackage);
  mkdirSync(destination, { recursive: true });
  const packagePath = join(destination, 'agent-device');
  cpSync(agentDevicePackage, packagePath, { recursive: true, verbatimSymlinks: true });
  const dist = join(packagePath, 'dist/src');
  copyFileSync(nativeSource, join(dist, 'native-process.c'));
  copyFileSync(join(assets, 'ps-bridge.mjs'), join(dist, 'ps-bridge.mjs'));
  chmodSync(join(dist, 'ps-bridge.mjs'), 0o755);
  execFileSync(
    '/usr/bin/clang',
    [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      join(dist, 'native-process.c'),
      '-o',
      join(dist, 'native-process'),
    ],
    { timeout: 30_000 },
  );
  writeFileSync(join(dist, 'host-process.js'), patchedHost);
  mkdirSync(join(destination, 'bin'));
  copyFileSync(join(assets, 'xcodebuild'), join(destination, 'bin/xcodebuild'));
  chmodSync(join(destination, 'bin/xcodebuild'), 0o755);
  writeFileSync(jsi, patchedJsi);
  const manifest = {
    schema: 1,
    preparedAt: new Date().toISOString(),
    architecture: process.arch,
    sourceCommit,
    nativeSourceSha256: expectedNativeSourceSha256,
    agentDeviceVersion: metadata.version,
    originalPackageSha256,
    agentDevicePackageSha256: packageHash(packagePath),
    originalHostSha256: originalHostHash,
    originalJsiSha256: originalJsiHash,
    jsiSha256: fileHash(jsi),
    xcodebuildSha256: fileHash(join(destination, 'bin/xcodebuild')),
    xcodebuildMode: lstatSync(join(destination, 'bin/xcodebuild')).mode & 0o777,
    bridgeSha256: fileHash(join(dist, 'ps-bridge.mjs')),
  };
  const path = join(destination, 'manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path, sha256: fileHash(path), ...manifest };
}

export function verifyNativeCompatibility(path, expectedSha256, fixture, agentDeviceBin) {
  if (!path) {
    if (expectedSha256) throw new Error('pinned native compatibility manifest is missing');
    return null;
  }
  if (!expectedSha256 || fileHash(path) !== expectedSha256)
    throw new Error('native compatibility manifest hash mismatch');
  const directory = dirname(realpathSync(path));
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.schema !== 1 || manifest.architecture !== process.arch)
    throw new Error('unsupported native compatibility manifest');
  const packagePath = join(directory, 'agent-device');
  if (packageHash(packagePath) !== manifest.agentDevicePackageSha256)
    throw new Error('agent-device compatibility package changed');
  const wrapper = join(directory, 'bin/xcodebuild');
  const wrapperMode = lstatSync(wrapper).mode & 0o777;
  if (
    fileHash(wrapper) !== manifest.xcodebuildSha256 ||
    wrapperMode !== manifest.xcodebuildMode ||
    !(wrapperMode & 0o100)
  )
    throw new Error('Xcode compatibility wrapper changed');
  if (fileHash(join(fixture, jsiRelative)) !== manifest.jsiSha256)
    throw new Error('ExpoModulesJSI compatibility patch missing or changed');
  if (realpathSync(agentDeviceBin) !== realpathSync(join(packagePath, 'bin/agent-device.mjs')))
    throw new Error('agent-device is not the compatibility package');
  return { ...manifest, manifestSha256: expectedSha256, directory };
}

export function probeNativeCompatibility(compatibility, execute) {
  if (!compatibility) return null;
  const host = pathToFileURL(join(compatibility.directory, 'agent-device/dist/src/host-process.js')).href;
  const script = `import assert from 'node:assert/strict';
    import {execFileSync} from 'node:child_process';
    import {realpathSync} from 'node:fs';
    import {c as start,s as command,i as zombie,a as list} from ${JSON.stringify(host)};
    assert.throws(() => execFileSync('/bin/ps',['-p',String(process.pid),'-o','command=']));
    assert(start(process.pid)); assert(command(process.pid)); assert.equal(zombie(process.pid),false);
    assert((await list({timeoutMs:5000})).some(x => x.pid === process.pid));
    const xcode = execFileSync('/usr/bin/which',['xcodebuild'],{encoding:'utf8'}).trim();
    assert.equal(realpathSync(xcode),${JSON.stringify(join(compatibility.directory, 'bin/xcodebuild'))});
    const version = execFileSync(xcode,['-version'],{encoding:'utf8',timeout:10000}).trim();
    console.log(JSON.stringify({processIdentity:true,xcodeVersion:version}));`;
  return JSON.parse(execute(process.execPath, ['--input-type=module', '-e', script]));
}

export function collectedNativeCompatibility(meta, worktree) {
  const expected = meta.preflight?.nativeCompatibility;
  if (!expected) return null;
  try {
    if (!meta.preflight.nativeCompatibilityProbe?.processIdentity)
      throw new Error('sandbox compatibility probe missing');
    if (!worktree || !existsSync(worktree)) throw new Error('run worktree missing for compatibility validation');
    verifyNativeCompatibility(
      join(expected.directory, 'manifest.json'),
      expected.manifestSha256,
      worktree,
      join(expected.directory, 'agent-device/bin/agent-device.mjs'),
    );
    return { valid: true, manifestSha256: expected.manifestSha256 };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}
