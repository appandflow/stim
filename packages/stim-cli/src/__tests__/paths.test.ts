import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureWorkspaceStorage, workspaceDir, workspaceMetadataFile, workspaceName } from '../workspace/paths.ts';

describe('workspace storage', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
    process.env.STIM_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test('ensureWorkspaceStorage records ownership and refuses a mismatched record', () => {
    const root = join(tmpdir(), 'Readable App');
    expect(ensureWorkspaceStorage(root)).toBe(workspaceDir(root));
    expect(JSON.parse(readFileSync(workspaceMetadataFile(root), 'utf-8'))).toEqual({
      projectRoot: root,
      workspace: workspaceName(root),
      version: 1,
    });

    writeFileSync(workspaceMetadataFile(root), '{"projectRoot":"/somewhere/else"}\n');
    expect(() => ensureWorkspaceStorage(root)).toThrow(/workspace collision/);
  });
});
