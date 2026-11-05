import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packMacosArtifact, unpackMacosArtifact } from '../macos/artifact-file.ts';

describe.skipIf(process.platform === 'win32')('macOS artifact files', () => {
  let directory: string;
  let bundle: string;
  let archive: string;
  let destination: string;
  const signal = () => new AbortController().signal;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'stim-macos-artifact-'));
    process.env.STIM_HOME = join(directory, 'home');
    bundle = join(directory, 'App.app');
    archive = join(directory, 'artifact');
    destination = join(directory, 'restored.app');
    mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
    mkdirSync(join(bundle, 'Contents/Resources'));
    mkdirSync(join(bundle, 'Contents/Resources/empty-directory'));
    writeFileSync(join(bundle, 'Contents/Info.plist'), 'plist');
    writeFileSync(join(bundle, 'Contents/MacOS/App'), 'executable bytes');
    chmodSync(join(bundle, 'Contents/MacOS/App'), 0o755);
    writeFileSync(join(bundle, 'Contents/Resources/message.txt'), 'resource bytes');
    writeFileSync(join(bundle, 'Contents/Resources/empty'), '');
  });

  afterEach(() => {
    delete process.env.STIM_HOME;
    rmSync(directory, { recursive: true, force: true });
  });

  test('corrupt and truncated payloads cannot be accepted as completed artifacts', async () => {
    await packMacosArtifact(bundle, 'key', archive, signal());
    const original = readFileSync(archive);
    writeFileSync(archive, original.subarray(0, original.length - 1));
    await expect(unpackMacosArtifact(archive, 'key', destination, signal())).rejects.toThrow('length');
    const altered = Buffer.from(original);
    altered.writeUInt8(altered.readUInt8(altered.length - 1) ^ 1, altered.length - 1);
    writeFileSync(archive, altered);
    await expect(unpackMacosArtifact(archive, 'key', destination, signal())).rejects.toThrow('digest');
  });

  test('manifest traversal is rejected before materializing a payload', async () => {
    await packMacosArtifact(bundle, 'key', archive, signal());
    const bytes = readFileSync(archive);
    const size = bytes.readUInt32BE(9);
    const receipt = JSON.parse(bytes.subarray(13, 13 + size).toString('utf8'));
    receipt.files[0].path = '../escaped';
    const json = Buffer.from(JSON.stringify(receipt));
    const header = Buffer.from(bytes.subarray(0, 13));
    header.writeUInt32BE(json.length, 9);
    writeFileSync(archive, Buffer.concat([header, json, bytes.subarray(13 + size)]));
    await expect(unpackMacosArtifact(archive, 'key', destination, signal())).rejects.toThrow('inventory');
    expect(() => lstatSync(join(directory, 'escaped'))).toThrow('ENOENT');
  });

  test.skipIf(process.platform === 'win32')(
    'contained framework-style links survive without following outside links',
    async () => {
      symlinkSync('message.txt', join(bundle, 'Contents/Resources/alias'));
      const framework = join(bundle, 'Contents/Frameworks/Proof.framework');
      mkdirSync(join(framework, 'Versions/A/Resources'), { recursive: true });
      writeFileSync(join(framework, 'Versions/A/Proof'), 'framework bytes');
      chmodSync(join(framework, 'Versions/A/Proof'), 0o755);
      writeFileSync(join(framework, 'Versions/A/Resources/icon'), 'framework resource');
      symlinkSync('A', join(framework, 'Versions/Current'));
      symlinkSync('Versions/Current/Proof', join(framework, 'Proof'));
      symlinkSync('Versions/Current/Resources', join(framework, 'Resources'));
      await packMacosArtifact(bundle, 'key', archive, signal());
      await unpackMacosArtifact(archive, 'key', destination, signal());
      expect(readlinkSync(join(destination, 'Contents/Resources/alias'))).toBe('message.txt');
      expect(readFileSync(join(destination, 'Contents/Resources/alias'), 'utf8')).toBe('resource bytes');
      expect(readFileSync(join(destination, 'Contents/Frameworks/Proof.framework/Proof'), 'utf8')).toBe(
        'framework bytes',
      );
      expect(readFileSync(join(destination, 'Contents/Frameworks/Proof.framework/Resources/icon'), 'utf8')).toBe(
        'framework resource',
      );
      rmSync(destination, { recursive: true });
      rmSync(archive);
      rmSync(join(bundle, 'Contents/Resources/alias'));
      symlinkSync('../../../outside', join(bundle, 'Contents/Resources/alias'));
      await packMacosArtifact(bundle, 'key', archive, signal());
      await expect(unpackMacosArtifact(archive, 'key', destination, signal())).rejects.toThrow('leaves its bundle');
    },
  );

  test('cancellation refuses restore before creating any app files', async () => {
    await packMacosArtifact(bundle, 'key', archive, signal());
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(unpackMacosArtifact(archive, 'key', destination, controller.signal)).rejects.toThrow('cancelled');
    expect(() => lstatSync(destination)).toThrow('ENOENT');
  });
});
