import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fingerprintNativeInputs } from '../integrations/native-inputs.ts';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stim-native-inputs-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const snapshot = (root: string, excluded: string[] = [], parameters = { variant: 'debug' }) =>
  fingerprintNativeInputs([{ name: 'project', path: root }], { excluded, parameters });

test.skipIf(process.platform === 'win32')(
  'linked external source bytes participate and output links are refused',
  async () => {
    const root = join(directory, 'project');
    const external = join(directory, 'external');
    mkdirSync(root);
    write(join(external, 'Resources/data.txt'), 'one');
    symlinkSync('../external', join(root, 'shared'));
    const before = await snapshot(root);
    write(join(external, 'Resources/data.txt'), 'two');
    expect((await snapshot(root)).hash).not.toBe(before.hash);
    await expect(snapshot(root, [external])).rejects.toThrow('links into an excluded output');
  },
);

test.skipIf(process.platform === 'win32')('cyclic and dangling links refuse a partial input identity', async () => {
  const root = join(directory, 'project');
  mkdirSync(root);
  symlinkSync('.', join(root, 'loop'));
  await expect(snapshot(root)).rejects.toThrow('cycle');
  rmSync(join(root, 'loop'));
  symlinkSync('../missing', join(root, 'dangling'));
  await expect(snapshot(root)).rejects.toThrow('Could not read native build inputs');
});

test('cancelling a streamed fingerprint rejects without a partial identity and leaves other calls usable', async () => {
  const root = join(directory, 'project');
  mkdirSync(root);
  writeFileSync(join(root, 'large'), Buffer.alloc(32 * 1024 * 1024, 1));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('stop hashing')), 5);
  try {
    await expect(
      fingerprintNativeInputs([{ name: 'project', path: root }], {
        parameters: null,
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop hashing');
    const recovered = await fingerprintNativeInputs([{ name: 'project', path: root }], { parameters: null });
    expect(recovered.entries.find((entry) => entry.path === 'project/large')?.sha256).toBe(
      'e35460e26db59551591797d5d9f6c5dcc1177e7b9ad3947eaafe1fe7432e84ee',
    );
  } finally {
    clearTimeout(timer);
  }
});
