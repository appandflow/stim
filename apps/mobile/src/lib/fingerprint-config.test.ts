declare const require: {
  (id: string): any;
  resolve: (id: string, options?: { paths?: string[] }) => string;
};
declare const __dirname: string;

// apps/mobile has no @types/node dependency, so node builtins are required rather than imported
// to avoid adding one just for this test.
const fs = require('node:fs') as {
  mkdtempSync: (prefix: string) => string;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, contents: string) => void;
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
};
const os = require('node:os') as { tmpdir: () => string };
const path = require('node:path') as {
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
};

// apps/mobile has no direct dependency on @expo/fingerprint; the OTA runtime fingerprint that
// motivated this config (stim#1814) is computed by expo-updates through the app's own `expo`
// dependency, so resolve the same copy from there rather than from an unrelated package's.
const expoDir = path.dirname(require.resolve('expo/package.json'));
const fingerprintPkgPath = require.resolve('@expo/fingerprint/package.json', { paths: [expoDir] });
const fingerprintDir = path.dirname(fingerprintPkgPath);

// build/Config and build/sourcer/Bare aren't re-exported from the package's index, and the
// package has no `exports` map restricting deep imports, so this reaches them directly.
const { loadConfigAsync } = require(path.join(fingerprintDir, 'build/Config')) as {
  loadConfigAsync: (projectRoot: string) => Promise<{ sourceSkips?: number } | null>;
};
const { getPackageJsonScriptSourcesAsync } = require(path.join(fingerprintDir, 'build/sourcer/Bare')) as {
  getPackageJsonScriptSourcesAsync: (projectRoot: string, options: { sourceSkips: number }) => Promise<unknown[]>;
};

const projectRoot = path.join(__dirname, '../../');

function withAddedScript(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stim-fingerprint-scripts-'));
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  pkg.scripts = { ...pkg.scripts, 'stim-test-added-script': 'echo added' };
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2));
  return tmpDir;
}

describe('apps/mobile fingerprint.config.js PackageJsonScriptsAll skip', () => {
  it('does not change the package.json scripts fingerprint source when a script is added', async () => {
    const config = await loadConfigAsync(projectRoot);
    const options = { sourceSkips: config!.sourceSkips ?? 0 };
    const before = await getPackageJsonScriptSourcesAsync(projectRoot, options);

    const tmpDir = withAddedScript();
    try {
      const after = await getPackageJsonScriptSourcesAsync(tmpDir, options);
      expect(after).toEqual(before);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
