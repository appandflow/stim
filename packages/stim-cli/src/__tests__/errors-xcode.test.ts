import { createXcodeDiagnosticCollector } from '../engine/errors-xcode.ts';
import type { Diagnostic } from '../engine/errors-xcode.ts';
import { readFileSync } from 'node:fs';

function extractXcodeDiagnostics(
  transcript: string,
  root: string | null = null,
  sdk = 'iphonesimulator',
): Diagnostic[] {
  const collector = createXcodeDiagnosticCollector(root, sdk);
  for (const line of transcript.split('\n')) collector.push(line);
  return collector.diagnostics;
}

[
  "CompileC /tmp/stim-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/main.o /tmp/stim-xc/Scratch/main.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/stim-xc',
  '    ',
  '    Using response file: /tmp/stim-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/e6072d4f65d7061329687fe24e3d63a7-common-args.resp',
  '    ',
  '    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -x  [argv elided] cratch.build/Objects-normal/arm64/main.o',
  "/tmp/stim-xc/Scratch/main.m:5:18: error: use of undeclared identifier 'undefinedThing'",
  '    5 |     NSLog(@"%@", undefinedThing);',
  '      |                  ^~~~~~~~~~~~~~',
  "/tmp/stim-xc/Scratch/main.m:6:19: error: implicit conversion of 'int' to 'NSString *' is disallowed with ARC",
  '    6 |     NSString *s = 42;',
  '      |                   ^~',
  '2 errors generated.',
  '',
  '** BUILD FAILED **',
  '',
  '',
  'The following build commands failed:',
  "\tCompileC /tmp/stim-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/main.o /tmp/stim-xc/Scratch/main.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target 'Scratch' from project 'Scratch')",
  '\tBuilding project Scratch with scheme Scratch and configuration Debug',
  '(2 failures)',
].join('\n');

const REAL_LINK_FAILURE = [
  "Ld /tmp/stim-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/Binary/Scratch normal arm64 (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/stim-xc',
  '    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -Xl [argv elided] uild/Objects-normal/arm64/Binary/Scratch',
  'Undefined symbols for architecture arm64:',
  '  "_stimMissingFunction", referenced from:',
  '      _main in main.o',
  'ld: symbol(s) not found for architecture arm64',
  '/tmp/stim-xc/Scratch.xcodeproj: Scratch: clang: error: linker command failed with exit code 1 (use -v to see invocation)',
  '',
  "Ld /tmp/stim-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/x86_64/Binary/Scratch normal x86_64 (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/stim-xc',
  '    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -Xl [argv elided] ild/Objects-normal/x86_64/Binary/Scratch',
  'Undefined symbols for architecture x86_64:',
  '  "_stimMissingFunction", referenced from:',
  '      _main in main.o',
  '',
  '** BUILD FAILED **',
  '',
  '',
  'The following build commands failed:',
  "\tLd /tmp/stim-xc/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Objects-normal/arm64/Binary/Scratch normal arm64 (in target 'Scratch' from project 'Scratch')",
  '\tBuilding project Scratch with scheme Scratch and configuration Debug',
  '(2 failures)',
].join('\n');

const REAL_PODS_FAILURE = [
  '',
  "PhaseScriptExecution [CP]\\ Check\\ Pods\\ Manifest.lock /tmp/stim-xc-pods/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Script-AA00000000000000000020.sh (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/stim-xc-pods',
  '    /bin/sh -c /tmp/stim-xc-pods/dd/Build/Intermediates.noindex/Scratch.build/Debug-iphonesimulator/Scratch.build/Script-AA00000000000000000020.sh',
  "error: The sandbox is not in sync with the Podfile.lock. Run 'pod install' or update your CocoaPods installation.",
  '',
  "ProcessInfoPlistFile /tmp/stim-xc-pods/dd/Build/Products/Debug-iphonesimulator/Scratch.app/Info.plist /tmp/stim-xc-pods/Scratch/Info.plist (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/stim-xc-pods',
  '    builtin-infoPlistUtility /tmp/stim-xc-pods/Scratch/Info.plist -producttype com.apple.product-type.application -genpkginfo /tmp/stim-xc-pods/dd/Build/Products/Debug-iphonesimulator/Scratch.app/PkgInfo -expandbuildsettings -format binary -platform iphonesimulator -o /tmp/stim-xc-pods/dd/Build/Products/Debug-iphonesimulator/Scratch.app/Info.plist',
  '',
  "warning: Run script build phase '[CP] Check Pods Manifest.lock' will be run during every build because it does not specify any outputs. To address this issue, either add output dependencies to the script phase, or configure it to run in every build by unchecking \"Based on dependency analysis\" in the script phase. (in target 'Scratch' from project 'Scratch')",
  '** BUILD FAILED **',
  '',
].join('\n');

[
  'Build description signature: 5aff88b39ca8e2b9798e399e4ba14334',
  'Build description path: /tmp/stim-xc/dd-dev/Build/Intermediates.noindex/XCBuildData/5aff88b39ca8e2b9798e399e4ba14334.xcbuilddata',
  "/tmp/stim-xc/Scratch.xcodeproj: error: No profiles for 'com.stimcli.scratch' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'com.stimcli.scratch'. Automatic signing is disabled and unable to generate a profile. To enable automatic signing, pass -allowProvisioningUpdates to xcodebuild. (in target 'Scratch' from project 'Scratch')",
  '** BUILD FAILED **',
  '',
].join('\n');

const REAL_SCHEME_FAILURE = [
  'Command line invocation:',
  '    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project Scratch.xcodeproj -scheme NoSuchScheme -configuration Debug -sdk iphonesimulator build',
  '',
  'Build settings from command line:',
  '    SDKROOT = iphonesimulator26.5',
  '',
  '2026-08-25 13:18:28.966 xcodebuild[94932:16893065] Writing error result bundle to /var/folders/4g/960y2hbs4z73qw_nddslgmgh0000gn/T/ResultBundle_2026-25-08_13-18-0028.xcresult',
  'xcodebuild: error: The project named "Scratch" does not contain a scheme named "NoSuchScheme". The "-list" option can be used to find the names of the schemes in the project.',
  '',
].join('\n');

[
  "RegisterExecutionPolicyException /tmp/stim-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/stim-xc',
  '    builtin-RegisterExecutionPolicyException /tmp/stim-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app',
  '',
  "Validate /tmp/stim-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/stim-xc',
  '    builtin-validationUtility /tmp/stim-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app -shallow-bundle -infoplist-subpath Info.plist',
  '',
  "Touch /tmp/stim-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app (in target 'Scratch' from project 'Scratch')",
  '    cd /tmp/stim-xc',
  '    /usr/bin/touch -c /tmp/stim-xc/dd/Build/Products/Debug-iphonesimulator/Scratch.app',
  '',
  '** BUILD SUCCEEDED **',
  '',
].join('\n');

describe('real transcripts', () => {
  test('a link failure reports the missing symbol ONCE across both simulator slices', () => {
    const found = extractXcodeDiagnostics(REAL_LINK_FAILURE);
    expect(found.map((d) => d.message)).toEqual([
      'Undefined symbol: _stimMissingFunction',
      'ld: symbol(s) not found for architecture arm64',
      'linker command failed with exit code 1 (use -v to see invocation)',
    ]);
    expect(found[2]?.file).toBe('/tmp/stim-xc/Scratch.xcodeproj');
    expect(found[0]?.file).toBe(undefined);
  });

  test('the run-script warning in that same transcript is not promoted to an error', () => {
    expect(REAL_PODS_FAILURE.includes('warning: Run script build phase')).toBeTruthy();
    expect(extractXcodeDiagnostics(REAL_PODS_FAILURE).length).toBe(1);
  });

  test('an xcodebuild invocation error survives its own timestamped log line', () => {
    const found = extractXcodeDiagnostics(REAL_SCHEME_FAILURE);
    expect(found.length).toBe(1);
    expect(found[0]?.message).toMatch(/does not contain a scheme named "NoSuchScheme"/);
    expect(found[0]?.remedy).toMatch(/xcodebuild -list/);
    expect(found[0]?.file).toBe(undefined);
  });
});

describe('what is and is not a diagnostic', () => {
  test('a development team error is a signing error however it is phrased', () => {
    const transcript = '/app/ios/App.xcodeproj: error: Signing for "App" requires a development team.';
    const found = extractXcodeDiagnostics(transcript);
    expect(found.length).toBe(1);
    expect(found[0]?.remedy).toMatch(/needs no signing/);
  });
});

describe('a failed script phase', () => {
  const transcript = readFileSync(new URL('./fixtures/xcodebuild-script-phase-failure.txt', import.meta.url), 'utf-8')
    .split('\n')
    .filter((line) => !line.startsWith('# '));

  test('leads with the failed phase and the error its wrapped output ended on, not the first diagnostics', () => {
    const collector = createXcodeDiagnosticCollector();
    for (const line of transcript) collector.push(line);
    const messages = collector.diagnostics.map((d) => d.message);
    expect(messages.slice(0, 5)).toEqual([
      'Build phase failed: "Bundle React Native code and images" (target ExampleApp)',
      'Auth token is required for this request. Please run `sentry-cli login` and try again!',
      'Add --log-level=[info|debug] or export SENTRY_LOG_LEVEL=[info|debug] to see more output.',
      'Please attach the full debug log to all bug reports.',
      'To disable source maps auto upload, set SENTRY_DISABLE_AUTO_UPLOAD=true in your environment variables. Or to allow failing upload, set SENTRY_ALLOW_FAILURE=true',
    ]);
  });
});
