import { windowsShortDir } from '@stim-cli/core/state';
import { workerGradleDaemons } from '../src/build.ts';

const DAEMON = 'org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.4.1';

test('finds the Gradle and Kotlin daemons in CRLF Windows listings by each client short Gradle home', () => {
  const root = 'C:\\Users\\me\\.stim\\build-worker';
  const home = (client: string) => windowsShortDir(`${root}\\${client}\\cache\\gradle`, 'C:');
  const listing = [
    `4 java.exe -cp ${home('a')}\\wrapper\\dists\\gradle-9.4.1\\lib\\gradle-daemon-main-9.4.1.jar ${DAEMON}`,
    `5 java.exe -cp ${home('a').toUpperCase()}\\caches\\kotlin-compiler-embeddable.jar KotlinCompileDaemon`,
    `6 java.exe -cp ${home('b')}\\wrapper\\gradle-daemon-main-9.4.1.jar ${DAEMON}`,
    `7 java.exe -cp C:\\elsewhere\\gradle-daemon-main-9.4.1.jar ${DAEMON}`,
    '8 ',
  ].join('\r\n');
  expect(workerGradleDaemons(listing, root, 'win32', ['a'])).toEqual([
    { pid: 4, client: 'a' },
    { pid: 5, client: 'a' },
  ]);
});

test('finds only Gradle daemons under a client Gradle home in ps output', () => {
  const listing = [
    ` 41 java -cp /w/root/a/cache/gradle/wrapper/gradle-daemon-main.jar ${DAEMON}`,
    ' 42 java -cp /w/root/a/cache/gradle/caches/kotlin.jar KotlinCompileDaemon',
    ` 43 java -cp /other/a/cache/gradle/wrapper/gradle-daemon-main.jar ${DAEMON}`,
  ].join('\n');
  expect(workerGradleDaemons(listing, '/w/root', 'darwin')).toEqual([{ pid: 41, client: 'a' }]);
});
