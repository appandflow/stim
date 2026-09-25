import { parseVmStatUsedBytes } from '../src/machine.ts';

const VM_STAT = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   844671.
Pages active:                                 883462.
Pages inactive:                               865163.
Pages speculative:                             16858.
Pages throttled:                                   0.
Pages wired down:                             278582.
Pages purgeable:                               21474.
"Translation faults":                     6657829781.
Pages copy-on-write:                       459204590.
Pages zero filled:                        3415659203.
Pages reactivated:                         184864288.
Pages purged:                               44861833.
File-backed pages:                            968989.
Anonymous pages:                              796494.
Pages stored in compressor:                   451675.
Pages occupied by compressor:                 202982.
Decompressions:                            164110051.
Compressions:                              245810380.
Pageins:                                    97735037.
Pageouts:                                     131342.
Swapins:                                     1396609.
Swapouts:                                    2365810.
`;

describe('parseVmStatUsedBytes', () => {
  it('adds app memory, wired and compressed pages at the page size of the header', () => {
    expect(parseVmStatUsedBytes(VM_STAT)).toBe((796494 - 21474 + 278582 + 202982) * 16384);
  });

  it('returns null when a count it needs is missing', () => {
    expect(parseVmStatUsedBytes(VM_STAT.replace(/^Anonymous pages:.*$/m, ''))).toBeNull();
    expect(parseVmStatUsedBytes(VM_STAT.replace(/page size of \d+ bytes/, ''))).toBeNull();
  });
});
