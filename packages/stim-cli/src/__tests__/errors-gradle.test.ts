import { extractGradleDiagnostics } from '../engine/errors-gradle.ts';

describe('what is recognized', () => {
  test('kotlinc pre-K2 diagnostics are recognized too', () => {
    const diagnostics = extractGradleDiagnostics(
      'e: /Users/me/app/android/app/src/main/java/com/app/Main.kt: (10, 5): Unresolved reference: foo',
    );
    expect(diagnostics).toEqual([
      {
        message: 'Unresolved reference: foo',
        file: '/Users/me/app/android/app/src/main/java/com/app/Main.kt',
        line: 10,
        column: 5,
      },
    ]);
  });

  test('javac diagnostics keep the file and line', () => {
    const diagnostics = extractGradleDiagnostics(
      '/Users/me/app/android/app/src/main/java/com/app/MainApplication.java:31: error: cannot find symbol\n' +
        '      return Foo.getPackages();\n' +
        '             ^\n' +
        '  symbol:   variable Foo\n' +
        '1 error',
    );
    expect(diagnostics).toEqual([
      {
        message: 'cannot find symbol',
        file: '/Users/me/app/android/app/src/main/java/com/app/MainApplication.java',
        line: 31,
      },
    ]);
  });

  test('aapt2 resource errors keep the resource file, line and column', () => {
    const diagnostics = extractGradleDiagnostics(
      '> Task :app:processDebugResources FAILED\n' +
        'ERROR:/Users/me/app/android/app/src/main/res/values/strings.xml:5:5: AAPT: error: unclosed token.\n' +
        '\n' +
        'error: failed linking references.\n',
    );
    const resource = diagnostics.find((d) => d.file);
    expect(resource).toEqual({
      message: 'unclosed token.',
      file: '/Users/me/app/android/app/src/main/res/values/strings.xml',
      line: 5,
      column: 5,
    });
    expect(diagnostics.some((d) => d.message === 'failed linking references.')).toBeTruthy();
  });

  test('dependency resolution failures come back with a remedy', () => {
    const diagnostics = extractGradleDiagnostics(`
FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:compileDebugJavaWithJavac'.
> Could not resolve all files for configuration ':app:debugCompileClasspath'.
   > Could not find com.facebook.react:react-android:0.99.0.
`);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.message).toMatch(/Could not find com\.facebook\.react:react-android:0\.99\.0/);
    expect(diagnostics[0]?.remedy).toMatch(/refresh-dependencies/);
  });
});

describe('a packaging failure surfaces its cause however gradle interleaves its two streams', () => {
  test("a cause that quotes an inner tool's BUILD FAILED keeps the lines under it", () => {
    const diagnostics = extractGradleDiagnostics(
      [
        '* What went wrong:',
        "Execution failed for task ':app:someWrapper'.",
        '> Process exited with code 1',
        '  BUILD FAILED because the inner tool said so',
        '  real cause: the keystore is missing',
      ].join('\n'),
    );
    expect(diagnostics[0]?.message).toMatch(/the keystore is missing$/);
  });

  test('the cause chain stops at the next task line rather than swallowing the build', () => {
    const diagnostics = extractGradleDiagnostics(
      [
        "Execution failed for task ':app:packageDebug'.",
        '> A failure occurred while executing PackageAndroidArtifact',
        '> Task :app:packageRelease FAILED',
        'e: file:///w/Main.kt:10:5 Unresolved reference: foo',
      ].join('\n'),
    );
    expect(diagnostics.map((d) => d.message)).toEqual([
      "Execution failed for task ':app:packageDebug'. A failure occurred while executing PackageAndroidArtifact",
      'Task :app:packageRelease FAILED',
      'Unresolved reference: foo',
    ]);
  });
});
