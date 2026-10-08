import { expect, test } from 'vitest';
import { createRequestLog } from '../src/request-log.ts';

const setup = (debugOn: boolean) => {
  const lines: string[] = [];
  const records: unknown[] = [];
  let clock = 0;
  const log = createRequestLog({
    service: (line) => lines.push(line),
    debug: { enabled: () => debugOn, log: (event, fields) => records.push({ event, ...fields }) },
    now: () => clock,
  });
  return { lines, records, log, advance: (ms: number) => (clock += ms) };
};

test('without debug a successful or slow request writes nothing', () => {
  const { lines, records, log, advance } = setup(false);
  const tracker = log.track();
  tracker.begin(1, 'frames.subscribe');
  advance(5000);
  tracker.reply({ id: 1, result: {} });
  expect(lines).toEqual([]);
  expect(records).toEqual([]);
});

test('the same failure from one client is logged once a minute', () => {
  const { lines, log, advance } = setup(false);
  const tracker = log.track();
  tracker.identify({ id: 'dev1', runId: null });
  for (let id = 1; id <= 3; id++) {
    tracker.begin(id, 'logs.query');
    tracker.reply({ id, error: { code: 'bad-request', message: 'secret-looking text' } });
  }
  advance(61_000);
  tracker.begin(4, 'logs.query');
  tracker.reply({ id: 4, error: { code: 'bad-request', message: 'x' } });
  expect(lines).toHaveLength(2);
  expect(lines.join('')).not.toContain('secret-looking');
});

test('with debug every request is logged with its duration, slow flag and steps', () => {
  const { lines, records, log, advance } = setup(true);
  const tracker = log.track();
  tracker.identify({ id: 'dev1', runId: 'run-1' });
  tracker.begin(7, 'hello');
  tracker.step(7, 'whois', 1100.4);
  advance(1200);
  tracker.reply({ id: 7, result: {} });
  expect(lines).toEqual(['stim-server: debug request method=hello client=dev1 run=run-1 ms=1200 slow=true whois=1100']);
  expect(records).toEqual([
    { event: 'request', method: 'hello', client: 'dev1', runId: 'run-1', ms: 1200, slow: true, whois: 1100 },
  ]);
});

test('a host failure is logged without debug, a host success only with it', () => {
  const quiet = setup(false);
  quiet.log.host('host_connect', { host: 'mini', ms: 5 });
  quiet.log.host('host_connect', { host: 'mini', ms: 3000, error: 'the host did not connect in time' }, true);
  expect(quiet.lines).toEqual(['stim-server: host_connect host=mini ms=3000 error=the_host_did_not_connect_in_time']);
  const loud = setup(true);
  loud.log.host('host_connect', { host: 'mini', ms: 5 });
  expect(loud.records).toEqual([{ event: 'host_connect', host: 'mini', ms: 5 }]);
});

test('a method name cannot add a field or a line to the service log', () => {
  const { lines, log } = setup(false);
  const tracker = log.track();
  tracker.begin(1, 'x ms=0 error=none\nstim-server: forged');
  tracker.reply({ id: 1, error: { code: 'bad-request' } });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('method=unknown ');
  expect(lines[0]).not.toMatch(/\n| ms=0 error=none/);
});
