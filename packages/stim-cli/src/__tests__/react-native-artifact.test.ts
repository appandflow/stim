import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintProject } from '../cache/build-cache.ts';
import {
  findReactNativeArtifact,
  reactNativeArtifactReceipt,
  reactNativeBuildQuery,
} from '../offload/react-native-artifact.ts';
import { iosToolchainAsync } from '../offload/toolchain.ts';

vi.mock('../offload/toolchain.ts', () => ({
  iosToolchainAsync: vi.fn<typeof import('../offload/toolchain.ts').iosToolchainAsync>(async () => ({
    stimBuild: 'b1',
    arch: 'arm64',
    xcode: 'Xcode 27',
    simulatorSdk: '27',
    cocoapods: '1.16.2',
  })),
  workerToolchain: vi.fn<typeof import('../offload/toolchain.ts').workerToolchain>(),
}));

test('a completed RN receipt is invalidated by real fingerprint changes or a changed worker toolchain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stim-rn-artifact-'));
  try {
    await mkdir(join(root, 'ios', 'Sample.xcodeproj'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }));
    await writeFile(join(root, 'ios', 'Sample.xcodeproj', 'project.pbxproj'), 'native inputs');
    const fingerprint = await fingerprintProject(root, { platform: 'ios' });
    if (!fingerprint) throw new Error('The fixture did not fingerprint.');
    const build = {
      platform: 'ios',
      isExpo: false,
      runtime: 'iOS-27-0',
      configuration: null,
      scheme: null,
      optimizations: { compilationCache: true, swiftCompilationCache: null, prefixMapping: true },
    };
    const query = reactNativeBuildQuery(build, fingerprint.hash, '', await iosToolchainAsync(root));
    if (!query) throw new Error('The fixture query was refused.');
    const receipt = await reactNativeArtifactReceipt(query, root);
    if (!receipt) throw new Error('The toolchain was unavailable.');
    expect(await findReactNativeArtifact(root, query, receipt.receipt)).toEqual(receipt.identity);
    vi.mocked(iosToolchainAsync).mockResolvedValueOnce({
      stimBuild: 'b1',
      arch: 'arm64',
      xcode: 'Xcode 28',
      simulatorSdk: '28',
      cocoapods: '1.16.2',
    });
    expect(await findReactNativeArtifact(root, query, receipt.receipt)).toBeNull();
    await writeFile(join(root, 'ios', 'Sample.xcodeproj', 'project.pbxproj'), 'changed native inputs');
    expect(await findReactNativeArtifact(root, query, receipt.receipt)).toBeNull();
    expect(
      reactNativeBuildQuery({ ...build, configuration: 'Release' }, fingerprint.hash, '', query.toolchain),
    ).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
