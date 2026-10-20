import { readFile } from 'node:fs/promises';
import { readListeningPorts } from '../listening-ports.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn<typeof readFile>() }));

afterEach(() => {
  vi.resetAllMocks();
  resetExecutor();
});

test('Darwin listen queues include all address families, deduplicate ports and admit table-change notices', async () => {
  setExecutor({
    runFileAsync: async () => `Current listen queue sizes (qlen/incqlen/maxqlen)
Listen         Local Address
0/0/128        127.0.0.1.8082
0/0/128        ::1.8082
1/0/128        fe80::1%en0.8083
0/0/128        *.8900
Some tcp sockets may have been created or deleted.
`,
  });
  expect(await readListeningPorts('darwin')).toEqual(new Set([8082, 8083, 8900]));
});

test('Windows listeners are independent of localized states and exclude connected TCP and UDP ports', async () => {
  setExecutor({
    runFileAsync: async () => `Active Connections
Proto Local Address Foreign Address State
TCP 0.0.0.0:8082 0.0.0.0:0 ABH\u00D6REN
TCP [::]:8082 [::]:0 LISTENING
TCP [::1]:8083 [::]:0 LISTENING
TCP 127.0.0.1:8900 127.0.0.1:50000 ESTABLISHED
UDP 0.0.0.0:8901 *:*
`,
  });
  expect(await readListeningPorts('win32')).toEqual(new Set([8082, 8083]));
});

const HEADER = 'sl local_address rem_address st tx_queue rx_queue';

test('Linux combines IPv4 and IPv6 LISTEN sockets without treating other TCP states as listeners', async () => {
  vi.mocked(readFile).mockResolvedValueOnce(`${HEADER}
0: 0100007F:1F92 00000000:0000 0A 00000000:00000000
1: 0100007F:22C4 0100007F:C350 01 00000000:00000000
`);
  vi.mocked(readFile).mockResolvedValueOnce(`${HEADER}
0: 00000000000000000000000001000000:1F93 00000000000000000000000000000000:0000 0A 00000000:00000000
`);
  expect(await readListeningPorts('linux')).toEqual(new Set([8082, 8083]));
});

test('Linux permits an absent IPv6 table but propagates other table failures', async () => {
  vi.mocked(readFile)
    .mockResolvedValueOnce(`${HEADER}\n`)
    .mockRejectedValueOnce(Object.assign(new Error('absent'), { code: 'ENOENT' }));
  expect(await readListeningPorts('linux')).toEqual(new Set());

  vi.mocked(readFile)
    .mockResolvedValueOnce(`${HEADER}\n`)
    .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(readListeningPorts('linux')).rejects.toThrow('denied');

  vi.mocked(readFile)
    .mockRejectedValueOnce(Object.assign(new Error('no IPv4 table'), { code: 'ENOENT' }))
    .mockResolvedValueOnce(`${HEADER}\n`);
  await expect(readListeningPorts('linux')).rejects.toThrow('no IPv4 table');
});

test.each<[NodeJS.Platform, string]>([
  ['darwin', '0/0/128 ::1.invalid'],
  ['win32', 'TCP 127.0.0.1:invalid 0.0.0.0:0 LISTENING'],
  ['linux', `${HEADER}\n0: 0100007F:ZZZZ 00000000:0000 0A`],
])('%s malformed listener data refuses inspection', async (platform, output) => {
  setExecutor({ runFileAsync: async () => output });
  vi.mocked(readFile).mockResolvedValue(output);
  await expect(readListeningPorts(platform)).rejects.toThrow(/TCP/);
});

test.each<[NodeJS.Platform, string]>([
  ['darwin', ''],
  ['darwin', '0/0/128        127.0.0.1.8082'],
  ['win32', ''],
  ['win32', 'Active Connections\n'],
])('%s netstat output without its table refuses inspection', async (platform, output) => {
  setExecutor({ runFileAsync: async () => output });
  await expect(readListeningPorts(platform)).rejects.toThrow(/no TCP/);
});
