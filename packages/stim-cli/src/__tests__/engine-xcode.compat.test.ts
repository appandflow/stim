import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor } from '../exec.ts';
import { createNdjsonWriter, parseNdjsonText } from '../ndjson.ts';
import { workspaceDerivedData, workspaceLogsDir } from '../paths.ts';
import type { CompilationCacheActivity } from '../types.ts';
import { buildIos, discoverXcodeProject, resolveScheme } from '../engine/xcode.ts';

let tmp: string;
let stateHome: string;
let previousStateHome: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stim-xcode-'));
  stateHome = mkdtempSync(join(tmpdir(), 'stim-xcode-state-'));
  previousStateHome = process.env.STIM_HOME;
  process.env.STIM_HOME = stateHome;
});
afterEach(() => {
  resetExecutor();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
  if (previousStateHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = previousStateHome;
});

type BuildIosResultLike = {
  failed?: boolean;
  code?: string;
  exitCode?: number | null;
  appPath: string;
  bundleId: string;
  scheme: string;
  durationMs: number;
  transcriptLines: number;
  truncated: number;
  tail: string[];
  reason?: string;
  remedy?: string;
  diagnostics: Array<{
    message?: string;
    file?: string;
    line?: number;
    column?: number;
    remedy?: string;
    [key: string]: unknown;
  }>;
  compilationCache?: CompilationCacheActivity;
};

function asResult(value: unknown): BuildIosResultLike {
  return value as BuildIosResultLike;
}

const SCRATCH_PBXPROJ = `// !$*UTF8*$!
{
archiveVersion = 1;
classes = {
};
objectVersion = 54;
objects = {
AA00000000000000000001  = {isa = PBXBuildFile; fileRef = AA00000000000000000002 ; };
AA00000000000000000002  = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = main.m; sourceTree = "<group>"; };
AA00000000000000000003  = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
AA00000000000000000004  = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Scratch.app; sourceTree = BUILT_PRODUCTS_DIR; };
AA00000000000000000005  = {
isa = PBXFrameworksBuildPhase;
buildActionMask = 2147483647;
files = (
);
runOnlyForDeploymentPostprocessing = 0;
};
AA00000000000000000006 = {
isa = PBXGroup;
children = (
AA00000000000000000007 ,
AA00000000000000000008 ,
);
sourceTree = "<group>";
};
AA00000000000000000007  = {
isa = PBXGroup;
children = (
AA00000000000000000002 ,
AA00000000000000000003 ,
);
path = Scratch;
sourceTree = "<group>";
};
AA00000000000000000008  = {
isa = PBXGroup;
children = (
AA00000000000000000004 ,
);
name = Products;
sourceTree = "<group>";
};
AA00000000000000000009  = {
isa = PBXNativeTarget;
buildConfigurationList = AA0000000000000000000A ;
buildPhases = (
AA0000000000000000000B ,
AA00000000000000000005 ,
AA0000000000000000000C ,
);
buildRules = (
);
dependencies = (
);
name = Scratch;
productName = Scratch;
productReference = AA00000000000000000004 ;
productType = "com.apple.product-type.application";
};
AA0000000000000000000D  = {
isa = PBXProject;
attributes = {
BuildIndependentTargetsInParallel = 1;
LastUpgradeCheck = 1600;
};
buildConfigurationList = AA0000000000000000000E ;
compatibilityVersion = "Xcode 14.0";
developmentRegion = en;
hasScannedForEncodings = 0;
knownRegions = (
en,
Base,
);
mainGroup = AA00000000000000000006;
productRefGroup = AA00000000000000000008 ;
projectDirPath = "";
projectRoot = "";
targets = (
AA00000000000000000009 ,
);
};
AA0000000000000000000C  = {
isa = PBXResourcesBuildPhase;
buildActionMask = 2147483647;
files = (
);
runOnlyForDeploymentPostprocessing = 0;
};
AA0000000000000000000B  = {
isa = PBXSourcesBuildPhase;
buildActionMask = 2147483647;
files = (
AA00000000000000000001 ,
);
runOnlyForDeploymentPostprocessing = 0;
};
AA0000000000000000000F  = {
isa = XCBuildConfiguration;
buildSettings = {
ALWAYS_SEARCH_USER_PATHS = NO;
CLANG_ENABLE_OBJC_ARC = YES;
CODE_SIGNING_ALLOWED = NO;
CODE_SIGNING_REQUIRED = NO;
CODE_SIGN_IDENTITY = "";
COPY_PHASE_STRIP = NO;
DEBUG_INFORMATION_FORMAT = dwarf;
GCC_OPTIMIZATION_LEVEL = 0;
IPHONEOS_DEPLOYMENT_TARGET = 15.0;
ONLY_ACTIVE_ARCH = YES;
SDKROOT = iphoneos;
};
name = Debug;
};
AA00000000000000000010  = {
isa = XCBuildConfiguration;
buildSettings = {
ALWAYS_SEARCH_USER_PATHS = NO;
CLANG_ENABLE_OBJC_ARC = YES;
CODE_SIGNING_ALLOWED = NO;
CODE_SIGNING_REQUIRED = NO;
CODE_SIGN_IDENTITY = "";
COPY_PHASE_STRIP = NO;
IPHONEOS_DEPLOYMENT_TARGET = 15.0;
SDKROOT = iphoneos;
};
name = Release;
};
AA00000000000000000011  = {
isa = XCBuildConfiguration;
buildSettings = {
GENERATE_INFOPLIST_FILE = NO;
INFOPLIST_FILE = Scratch/Info.plist;
PRODUCT_BUNDLE_IDENTIFIER = com.stimcli.scratch;
PRODUCT_NAME = Scratch;
TARGETED_DEVICE_FAMILY = "1,2";
};
name = Debug;
};
AA00000000000000000012  = {
isa = XCBuildConfiguration;
buildSettings = {
GENERATE_INFOPLIST_FILE = NO;
INFOPLIST_FILE = Scratch/Info.plist;
PRODUCT_BUNDLE_IDENTIFIER = com.stimcli.scratch;
PRODUCT_NAME = Scratch;
TARGETED_DEVICE_FAMILY = "1,2";
};
name = Release;
};
AA0000000000000000000E  = {
isa = XCConfigurationList;
buildConfigurations = (
AA0000000000000000000F ,
AA00000000000000000010 ,
);
defaultConfigurationIsVisible = 0;
defaultConfigurationName = Release;
};
AA0000000000000000000A  = {
isa = XCConfigurationList;
buildConfigurations = (
AA00000000000000000011 ,
AA00000000000000000012 ,
);
defaultConfigurationIsVisible = 0;
defaultConfigurationName = Release;
};
};
rootObject = AA0000000000000000000D ;
}`;

const SCRATCH_SCHEME = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1600" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "AA00000000000000000009"
               BuildableName = "Scratch.app"
               BlueprintName = "Scratch"
               ReferencedContainer = "container:Scratch.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "AA00000000000000000009"
            BuildableName = "Scratch.app"
            BlueprintName = "Scratch"
            ReferencedContainer = "container:Scratch.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
</Scheme>`;

const SCRATCH_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>UILaunchScreen</key>
	<dict/>
</dict>
</plist>`;

const WORKING_MAIN = `#import <Foundation/Foundation.h>

int main(int argc, char *argv[]) {
  @autoreleasepool {
    NSLog(@"scratch");
  }
  return 0;
}
`;

const BROKEN_MAIN = `#import <Foundation/Foundation.h>

int main(int argc, char *argv[]) {
  @autoreleasepool {
    NSLog(@"%@", stimDeliberatelyUndefined);
  }
  return 0;
}
`;

function writeScratchProject(root: string, { main = WORKING_MAIN, workspace = false } = {}) {
  const ios = join(root, 'ios');
  const proj = join(ios, 'Scratch.xcodeproj');
  mkdirSync(join(proj, 'xcshareddata', 'xcschemes'), { recursive: true });
  mkdirSync(join(ios, 'Scratch'), { recursive: true });
  writeFileSync(join(proj, 'project.pbxproj'), SCRATCH_PBXPROJ);
  writeFileSync(join(proj, 'xcshareddata', 'xcschemes', 'Scratch.xcscheme'), SCRATCH_SCHEME);
  writeFileSync(join(ios, 'Scratch', 'Info.plist'), SCRATCH_INFO_PLIST);
  writeFileSync(join(ios, 'Scratch', 'main.m'), main);
  if (workspace) {
    const ws = join(ios, 'Scratch.xcworkspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, 'contents.xcworkspacedata'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version = "1.0">\n   <FileRef location = "group:Scratch.xcodeproj"></FileRef>\n</Workspace>\n',
    );
  }
  return ios;
}

const LIVE_DESTINATION = 'generic/platform=iOS Simulator';

describe('buildIos against a real xcodebuild', { timeout: 180_000 }, () => {
  beforeAll(() => {
    if (process.platform !== 'darwin')
      throw new Error('Compatibility requires macOS with Xcode, iOS and iOS Simulator SDKs.');
    console.log(getExecutor().runFile('xcodebuild', ['-version'], { timeoutMs: 15_000 }));
  });

  test('an explicitly named scheme builds its actual product even when its name differs', async () => {
    resetExecutor();
    writeScratchProject(tmp, { workspace: true });
    const dir = join(tmp, 'ios', 'Scratch.xcodeproj', 'xcshareddata', 'xcschemes');
    writeFileSync(join(dir, 'Staging App.xcscheme'), SCRATCH_SCHEME);
    const writer = createNdjsonWriter(join(workspaceLogsDir(tmp), 'explicit-scheme.ndjson'));
    try {
      const result = asResult(
        await buildIos({
          root: tmp,
          scheme: 'Staging App',
          destination: LIVE_DESTINATION,
          logWriter: writer,
          compilationCache: [],
        }),
      );
      expect(result.failed).toBeUndefined();
      expect(result.scheme).toBe('Staging App');
      expect(result.appPath).toMatch(/scheme-[a-f0-9]{64}\/Build\/Products\/Debug-iphonesimulator\/Scratch\.app$/);
      expect(existsSync(result.appPath)).toBe(true);
      expect(result.bundleId).toBe('com.stimcli.scratch');
    } finally {
      writer.close();
    }
  }, 120_000);
  test('resolves a real workspace scheme and uses the app name after the workspace is renamed', () => {
    resetExecutor();
    writeScratchProject(tmp, { workspace: true });
    const project = discoverXcodeProject(tmp);
    expect(project.kind).toBe('workspace');
    expect(project.path).toBe(join(tmp, 'ios', 'Scratch.xcworkspace'));
    expect(resolveScheme(project)).toEqual({ scheme: 'Scratch', schemes: ['Scratch'] });
    renameSync(join(tmp, 'ios', 'Scratch.xcworkspace'), join(tmp, 'ios', 'Renamed.xcworkspace'));
    writeFileSync(join(tmp, 'ios', 'Scratch.xcodeproj', 'xcshareddata', 'xcschemes', 'Other.xcscheme'), SCRATCH_SCHEME);
    const renamed = discoverXcodeProject(tmp);
    expect(resolveScheme(renamed).error?.code).toBe('STIM_NO_SCHEME');
    writeFileSync(join(tmp, 'app.json'), '{"name":"Scratch"}');
    expect(resolveScheme(renamed)).toEqual({ scheme: 'Scratch', schemes: ['Other', 'Scratch'] });
  }, 30_000);

  test.each([
    { compilationCache: true, swiftCompilationCache: false, prefixMapping: true },
    { compilationCache: false, swiftCompilationCache: false, prefixMapping: false },
    { compilationCache: false, swiftCompilationCache: false, prefixMapping: true },
    { compilationCache: true, swiftCompilationCache: true, prefixMapping: true },
  ])(
    'builds a real app with compiler optimizations %j',
    async (optimizations) => {
      resetExecutor();
      writeScratchProject(tmp);
      const logFile = join(workspaceLogsDir(tmp), 'build-ios.ndjson');
      const writer = createNdjsonWriter(logFile);
      const result = asResult(
        await buildIos({
          root: tmp,
          udid: 'unused-with-an-explicit-destination',
          destination: LIVE_DESTINATION,
          logWriter: writer,
          optimizations,
        }),
      );
      writer.close();

      expect(result.failed).toBe(undefined);
      expect(result.scheme).toBe('Scratch');
      expect(result.appPath).toBe(
        join(workspaceDerivedData(tmp), 'Build', 'Products', 'Debug-iphonesimulator', 'Scratch.app'),
      );
      expect(existsSync(result.appPath)).toBeTruthy();
      expect(result.bundleId).toBe('com.stimcli.scratch');
      expect(result.durationMs > 0).toBeTruthy();

      const records = parseNdjsonText(readFileSync(logFile, 'utf-8'));
      expect(records[0]?.event).toBe('build_start');
      expect(records[0]?.msg).toMatch(/^xcodebuild -project .*-derivedDataPath .* build [\s\S]+$/);
      expect(records[0]?.msg).toContain(
        ` COMPILATION_CACHE_ENABLE_CACHING=${optimizations.compilationCache ? 'YES' : 'NO'} `,
      );
      const transcript = records.filter((r) => r.level === 'debug');
      expect(transcript.length > 20).toBeTruthy();
      expect(transcript.every((r) => r.src === 'build')).toBeTruthy();
      expect(transcript.some((r) => r.msg?.includes('BUILD SUCCEEDED'))).toBeTruthy();
      expect(records.at(-1)?.event).toBe('build_done');
      expect(records.filter((r) => r.level === 'error').length).toBe(0);
    },
    120_000,
  );

  test('builds the device slice for real: -sdk iphoneos lands the .app in Debug-iphoneos', async () => {
    resetExecutor();
    writeScratchProject(tmp);
    const logFile = join(workspaceLogsDir(tmp), 'build-ios-device.ndjson');
    const writer = createNdjsonWriter(logFile);
    const result = asResult(
      await buildIos({
        root: tmp,
        udid: 'unused-with-an-explicit-destination',
        sdk: 'iphoneos',
        destination: 'generic/platform=iOS',
        logWriter: writer,
      }),
    );
    writer.close();

    expect(result.failed).toBe(undefined);
    expect(result.appPath).toBe(join(workspaceDerivedData(tmp), 'Build', 'Products', 'Debug-iphoneos', 'Scratch.app'));
    expect(existsSync(result.appPath)).toBeTruthy();
    expect(result.bundleId).toBe('com.stimcli.scratch');

    const records = parseNdjsonText(readFileSync(logFile, 'utf-8'));
    expect(records[0]?.msg).toMatch(/ -sdk iphoneos /);
    expect(records[0]?.msg).toMatch(/ -destination generic\/platform=iOS /);
    expect(records[0]?.msg).not.toMatch(/allowProvisioningUpdates|DEVELOPMENT_TEAM|CODE_SIGN_IDENTITY/);
    expect(records.some((r) => r.msg?.includes('BUILD SUCCEEDED'))).toBeTruthy();
  }, 180_000);

  test('fails for real: a broken source file becomes one diagnostic with file, line and column', async () => {
    resetExecutor();
    writeScratchProject(tmp, { main: BROKEN_MAIN });
    const logFile = join(workspaceLogsDir(tmp), 'build-ios.ndjson');
    const writer = createNdjsonWriter(logFile);
    const result = asResult(
      await buildIos({
        root: tmp,
        udid: 'unused-with-an-explicit-destination',
        destination: LIVE_DESTINATION,
        logWriter: writer,
      }),
    );
    writer.close();

    expect(result.failed).toBe(true);
    expect(result.code).toBe('STIM_BUILD_FAILED');
    expect(result.exitCode).toBe(65);
    expect(result.diagnostics.length).toBe(1);
    const [diagnostic] = result.diagnostics;
    assert(diagnostic);
    expect(diagnostic.file).toBe(join(tmp, 'ios', 'Scratch', 'main.m'));
    expect(diagnostic.line).toBe(5);
    expect(diagnostic.column).toBe(18);
    expect(diagnostic.message).toMatch(/use of undeclared identifier 'stimDeliberatelyUndefined'/);
    expect(diagnostic.remedy).toBe(undefined);
    expect(result.truncated).toBe(0);
    expect(result.tail.length).toBe(5);
    expect(result.tail.at(-1)).toMatch(/^\(\d+ failures\)$/);

    const records = parseNdjsonText(readFileSync(logFile, 'utf-8'));
    const errors = records.filter((r) => r.level === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0]?.msg).toMatch(/main\.m:5:18: use of undeclared identifier/);
    expect(records.some((r) => r.level === 'debug' && r.msg?.includes('** BUILD FAILED **'))).toBeTruthy();
  }, 120_000);
});
