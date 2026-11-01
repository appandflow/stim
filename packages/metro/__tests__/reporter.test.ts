import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ndjsonReporter } from '../index.ts';

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'stim-reporter-')));
}

function records(dir, file) {
  const text = fs.readFileSync(path.join(dir, file), 'utf-8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withDir(fn) {
  const dir = tempDir();
  try {
    fn(dir);
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a client symbolication response becomes info-level error context', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({
      type: 'client_symbolication',
      codeFrame: {
        fileName: '/app/App.tsx',
        location: { row: 18, column: 8 },
        content: '> 18 | throw new Error("boom")',
      },
      stack: [
        { file: '/app/App.tsx', lineNumber: 18, column: 8, methodName: 'App', collapse: false },
        { file: '/app/internal.js', lineNumber: 1, column: 2, methodName: 'internal', collapse: true },
      ],
    });

    const [record] = records(dir, 'client.ndjson');
    expect(record.level).toBe('info');
    expect(record.event).toBe('client_symbolication');
    expect(record.msg).toContain('Code: /app/App.tsx:18:8');
    expect(record.msg).toContain('Call Stack');
    expect(record.stack).toEqual([{ file: '/app/App.tsx', line: 18, column: 8, fn: 'App' }]);
  });
});

test('symbolication code frames from a real Metro /symbolicate response lose their escape codes and keep their frame lines', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    const content =
      '\x1b[0m \x1b[90m 29 |\x1b[39m       \x1b[36mthis\x1b[39m\x1b[33m.\x1b[39m\x1b[33m#\x1b[39mjsHeapSizeLimit \x1b[33m=\x1b[39m memoryInfo\x1b[33m.\x1b[39mjsHeapSizeLimit\x1b[33m;\x1b[39m\n' +
      '\x1b[31m\x1b[1m>\x1b[22m\x1b[39m\x1b[90m 30 |\x1b[39m       \x1b[36mthis\x1b[39m\x1b[33m.\x1b[39m\x1b[33m#\x1b[39mtotalJSHeapSize \x1b[33m=\x1b[39m memoryInfo\x1b[33m.\x1b[39mtotalJSHeapSize\x1b[33m;\x1b[39m\n' +
      ' \x1b[90m    |\x1b[39m                                         \x1b[31m\x1b[1m^\x1b[22m\x1b[39m\n' +
      ' \x1b[90m 31 |\x1b[39m   }\x1b[0m';
    reporter.update({
      type: 'client_symbolication',
      codeFrame: { fileName: '/app/MemoryInfo.js', location: { row: 30, column: 40 }, content },
    });

    const [record] = records(dir, 'client.ndjson');
    expect(record.msg).toBe(
      [
        'Code: /app/MemoryInfo.js:30:40',
        '  29 |       this.#jsHeapSizeLimit = memoryInfo.jsHeapSizeLimit;',
        '> 30 |       this.#totalJSHeapSize = memoryInfo.totalJSHeapSize;',
        '     |                                         ^',
        '  31 |   }',
        'Call Stack',
      ].join('\n'),
    );
  });
});

test('bundle_build_failed is a marker too, written before the bundling_error it precedes', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'bundle_build_failed', buildID: 'build_2' });
    reporter.update({ type: 'bundling_error', error: new Error('Unable to resolve module ./nope') });

    const lines = records(dir, 'metro.ndjson');
    expect(lines.length).toBe(2);
    const [marker, error] = lines;
    expect(marker.marker).toBe(true);
    expect(marker.level).toBe('info');
    expect(marker.event).toBe('bundle_build_failed');
    expect(marker.msg).toBe('bundle build failed (build_2)');
    expect(error.level).toBe('error');
    expect(error.marker).toBe(undefined);
    expect(error.ts >= marker.ts).toBeTruthy();
  });
});

test('overlapping bundle records keep their build id and platform', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'bundle_build_started', buildID: 'ios_1', bundleDetails: { platform: 'ios' } });
    reporter.update({ type: 'bundle_build_started', buildID: 'android_1', bundleDetails: { platform: 'android' } });
    reporter.update({ type: 'bundle_build_done', buildID: 'android_1' });
    reporter.update({ type: 'bundle_build_failed', buildID: 'ios_1' });
    reporter.update({ type: 'bundling_error', error: new Error('Unable to resolve module ./ios-only') });

    const lines = records(dir, 'metro.ndjson');
    expect(lines.map((record) => [record.event, record.buildID, record.platform])).toEqual([
      ['bundle_build_started', 'ios_1', 'ios'],
      ['bundle_build_started', 'android_1', 'android'],
      ['bundle_build_done', 'android_1', 'android'],
      ['bundle_build_failed', 'ios_1', 'ios'],
      ['bundling_error', 'ios_1', 'ios'],
    ]);
  });
});

test('unstable_server_log carries its own level', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    reporter.update({ type: 'unstable_server_log', level: 'warn', data: ['port', 8081] });

    const [rec] = records(dir, 'metro.ndjson');
    expect(rec.level).toBe('warn');
    expect(rec.src).toBe('metro');
    expect(rec.msg).toBe('port 8081');
  });
});

test('unknown and malformed shapes never throw, and never write a corrupt line', () => {
  withDir((dir) => {
    const reporter = ndjsonReporter({ dir });
    const circular = { self: null };
    circular.self = circular;

    expect(() => {
      reporter.update();
      reporter.update(null);
      reporter.update({});
      reporter.update({ type: 'client_log' });
      reporter.update({ type: 'client_log', level: 'log', data: circular });
      reporter.update({ type: 'bundling_error' });
      reporter.update({ type: 42 });
    }).not.toThrow();

    for (const file of ['metro.ndjson', 'client.ndjson']) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) continue;
      for (const rec of records(dir, file)) {
        expect(Number.isInteger(rec.ts)).toBeTruthy();
        expect(['debug', 'info', 'warn', 'error', 'fatal'].includes(rec.level)).toBeTruthy();
        expect(typeof rec.msg).toBe('string');
        expect(rec.src === 'metro' || rec.src === 'client').toBeTruthy();
      }
    }
  });
});

test.skipIf((Boolean(process.getuid) && process.getuid!() === 0) || process.platform === 'win32')(
  'an unwritable directory costs records, not the server (skipped on Windows: mode 500 does not take write access away from a directory)',
  () => {
    withDir((dir) => {
      const reporter = ndjsonReporter({ dir });
      fs.chmodSync(dir, 0o500);
      expect(() => {
        reporter.update({ type: 'client_log', level: 'log', data: ['lost'] });
        reporter.update({ type: 'bundling_error', error: new Error('also lost') });
      }).not.toThrow();
      expect(reporter.drops).toBe(2);
      expect(fs.existsSync(path.join(dir, 'metro.ndjson'))).toBe(false);

      fs.chmodSync(dir, 0o700);
      reporter.update({ type: 'bundle_build_done' });
      expect(records(dir, 'metro.ndjson').length).toBe(1);
      expect(reporter.drops).toBe(2);
    });
  },
);
