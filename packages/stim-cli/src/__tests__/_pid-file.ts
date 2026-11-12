import { readFileSync } from 'node:fs';
import { expect, vi } from 'vitest';

export function waitForPid(file: string): Promise<number> {
  return vi.waitFor(() => {
    const pid = Number(readFileSync(file, 'utf8').split('\n')[0]);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    return pid;
  });
}
