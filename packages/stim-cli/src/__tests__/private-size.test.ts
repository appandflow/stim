import { measureTree } from '../private-size.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

vi.mock('real-size', () => ({ binaryPath: () => '/fake/real-size' }));

const platform = process.platform;

afterEach(() => {
  resetExecutor();
  Object.defineProperty(process, 'platform', { value: platform });
});

test('uses du allocated bytes and marks the volume unknown when real-size exits 2 without output', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  setExecutor({
    ...getExecutor(),
    runFileAsync: async (file, args) => {
      if (file === '/fake/real-size' || args.includes('/fake/real-size'))
        throw Object.assign(new Error('unsupported filesystem'), { status: 2, stdout: '' });
      if (file === 'du' || args.includes('du')) return '8\t/tree\n';
      throw new Error(`unexpected command: ${file}`);
    },
  });

  expect(await measureTree('/tree', { timeoutMs: 1000 })).toEqual({
    bytes: 8192,
    privateBytes: null,
    privateUnknown: 'volume',
  });
});
