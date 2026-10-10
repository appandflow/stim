import { getExecutor, resetExecutor } from '../exec.ts';
import { parseTopMemory, readMemoryCulprits } from '../memory-culprits.ts';

test('the real top accepts the argv and every row it prints parses', () => {
  if (process.platform !== 'darwin') throw new Error('Compatibility requires macOS top.');
  resetExecutor();
  const executor = getExecutor();
  let output: string | null = null;
  const culprits = readMemoryCulprits({
    ...executor,
    runFileQuiet(file, args, options) {
      const result = executor.runFileQuiet(file, args, options);
      if (file === '/usr/bin/top') output = result;
      return result;
    },
  });
  expect(culprits).not.toBeNull();
  const rows = parseTopMemory(output ?? '');
  expect(rows).toHaveLength(20);
  for (const row of rows) {
    expect(row.pid).toBeGreaterThan(0);
    expect(row.bytes).toBeGreaterThan(0);
    expect(row.name.length).toBeGreaterThan(0);
  }
  expect(rows.map((row) => row.bytes)).toEqual(rows.map((row) => row.bytes).toSorted((a, b) => b - a));
});
