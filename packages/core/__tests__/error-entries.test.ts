import { readFileSync } from 'node:fs';
import { countErrorEntries } from '../state/error-entries.ts';
import { queryLogs, type NdjsonRecord } from '../state/index.ts';

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../apps/desktop/Tests/StimKitTests/Fixtures/log-entries-vectors.json', import.meta.url),
    'utf-8',
  ),
) as { groups: { name: string; records: NdjsonRecord[] }[] };

const rowsUnderErrorsOnly: Record<string, number> = {
  'an Expo syntax error with every record': 1,
  'an Expo syntax error under errors only, without the context': 1,
  'an Expo syntax error under errors only, with the context the CLI attached': 1,
  'a failed bundle response joins its failure': 1,
  'iOS and Android fail together': 2,
  'an Expo runtime error': 1,
  'an app error with a stack': 1,
  'a failed bundle response logged before its marker, with a device record between': 1,
  'error headers whose first part reads as a file': 3,
};

describe('the log entry vectors the apps replay', () => {
  it.each(vectors.groups.map((c) => [c.name, c] as const))('counts the rows of %s under errors only', (name, c) => {
    expect(countErrorEntries(queryLogs({ records: c.records, errorsOnly: true }))).toBe(rowsUnderErrorsOnly[name]);
  });
});

describe('countErrorEntries', () => {
  const marker = {
    src: 'metro',
    level: 'error',
    msg: 'iOS Bundling failed 128ms index.js',
    raw: true,
    event: 'expo_stdout',
    marker: true,
    ts: 1000,
  };
  const line = {
    src: 'metro',
    level: 'error',
    msg: ' ERROR  SyntaxError: x',
    raw: true,
    event: 'expo_stdout',
    ts: 1000,
  };
  const response = {
    src: 'metro',
    level: 'error',
    msg: 'ios bundle response failed',
    event: 'bundle_response_failed',
    platform: 'ios',
    ts: 1400,
  };

  it('counts a marker, its error line and its failed response as one failure', () => {
    expect(countErrorEntries([marker, line, response])).toBe(1);
  });

  it('counts a response for the other platform on its own', () => {
    expect(countErrorEntries([marker, line, { ...response, platform: 'android' }])).toBe(2);
  });

  it('counts nothing without errors', () => {
    expect(countErrorEntries([])).toBe(0);
  });
});
