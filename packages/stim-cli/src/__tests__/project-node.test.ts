import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unmetNodePin } from '../supervisor/project-node.ts';

describe('unmetNodePin', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'stim-project-node-'));
    mkdirSync(join(repo, 'apps', 'mobile'), { recursive: true });
    writeFileSync(join(repo, '.nvmrc'), '1.2.3\n');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('names the repository pin and the node on PATH when neither an install nor PATH satisfies it', () => {
    expect(unmetNodePin(join(repo, 'apps', 'mobile'), {}, { top: repo, nodeVersion: () => '26.7.0' })).toBe(
      'Node 26.7.0 on PATH does not satisfy .nvmrc 1.2.3, and no installed Node does.',
    );
  });

  it('reports nothing when the node on PATH satisfies the pin', () => {
    expect(unmetNodePin(join(repo, 'apps', 'mobile'), {}, { top: repo, nodeVersion: () => '1.2.3' })).toBeNull();
  });
});
