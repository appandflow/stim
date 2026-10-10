import { expect, test } from 'vitest';
import { findMemoryCulprits, parseTopMemory } from '../memory-culprits.ts';

const GIB = 1024 ** 3;
const RAM_48_GIB = 48 * GIB;

const CRITICAL_SAMPLE = `Processes: 712 total, 4 running, 708 sleeping, 4120 threads
Load Avg: 6.12, 5.80, 5.41  CPU usage: 12.5% user, 9.1% sys, 78.3% idle
PhysMem: 47G used (6912M wired, 31G compressor), 312M unused.
VM: 293T vsize, 4876M framework vsize, 9123456(0) swapins, 10234567(0) swapouts.

PID    MEM   COMMAND
76886  63G   fseventsd
2265   1722M com.apple.WebKit
1603   1608M simdiskimaged
402    1112M WindowServer
70538  1040M Claude Helper (R
616    955M  Finder
`;

const BUSY_NORMAL_SAMPLE = `PID    MEM   COMMAND
4410   6912M Xcode
8812   5120M qemu-system-aarc
9001   3410M+ java
2265   1722M- com.apple.WebKit
1603   1608M simdiskimaged
77     1290M watchman
402    1284M WindowServer
5310   88M   fseventsd
`;

test("tonight's critical sample flags only fseventsd, with its restart command", () => {
  expect(findMemoryCulprits(parseTopMemory(CRITICAL_SAMPLE), RAM_48_GIB)).toEqual([
    {
      pid: 76886,
      name: 'fseventsd',
      bytes: 63 * GIB,
      command: 'sudo killall fseventsd',
      note: expect.stringContaining('launchd restarts it'),
    },
  ]);
});

test('Xcode, an emulator, a Gradle daemon, a browser and normal daemons are not flagged', () => {
  const commandLines = new Map([
    [9001, '/opt/jdk/bin/java -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10'],
  ]);
  expect(findMemoryCulprits(parseTopMemory(BUSY_NORMAL_SAMPLE), RAM_48_GIB, commandLines)).toEqual([]);
});

test('a leaking Watchman is flagged below the general bar, and an unknown process gets no command', () => {
  const sample = `PID    MEM   COMMAND
9001   14G   java
9002   13G   java
9100   21G   SomeEditor Helpe
77     5120M watchman
`;
  const commandLines = new Map([
    [9001, '/opt/jdk/bin/java -Xmx16g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10'],
    [
      9002,
      '/opt/jdk/bin/java -cp kotlin-daemon.jar org.jetbrains.kotlin.daemon.KotlinCompileDaemon --daemon-runFilesPath x',
    ],
  ]);
  const flagged = findMemoryCulprits(parseTopMemory(sample), RAM_48_GIB, commandLines).map(({ name, command }) => ({
    name,
    command,
  }));
  expect(flagged).toEqual([
    { name: 'SomeEditor Helpe', command: null },
    { name: 'Gradle daemon', command: 'stim gc --delete --cache gradle-daemons' },
    { name: 'Kotlin daemon', command: 'stim gc --delete --cache gradle-daemons' },
    { name: 'Watchman', command: 'stim gc --delete --cache watchman' },
  ]);
});

test('on a 16 GiB Mac the general bar is 8 GiB, not a quarter of RAM', () => {
  const sample = `PID    MEM   COMMAND
4410   7900M Xcode
4411   8400M Xcode
`;
  expect(findMemoryCulprits(parseTopMemory(sample), 16 * GIB).map((culprit) => culprit.pid)).toEqual([4411]);
});
