import { decideTakeover } from '../policy/takeover.ts';

const PID = 4100;
const holder = { pid: PID, processToken: 'token' };

describe('taking over a running daemon', () => {
  test.each([
    ['a holder whose hello carries build is asked to hand over', holder, { pid: PID, build: 'b1' }, 'ask-handover'],
    ['a holder from before handovers gets SIGTERM', holder, { pid: PID, version: '1.40.0' }, 'sigterm'],
    ['a gone holder is left alone, whatever answers', null, { pid: PID, build: 'b1' }, 'none'],
    ['another process answering the socket is left alone', holder, { pid: PID + 1, build: 'b1' }, 'none'],
    ['a holder that does not answer is left alone', holder, null, 'none'],
  ])('%s', (_, record, hello, action) => {
    expect(decideTakeover(PID, record, hello).action).toBe(action);
  });

  test('the handover names the build the holder reported', () => {
    expect(decideTakeover(PID, holder, { pid: PID, build: 'b1' })).toEqual({ action: 'ask-handover', build: 'b1' });
  });

  test('only a live holder answering for itself is ever signalled or asked to exit', () => {
    const hellos = [null, {}, { pid: PID }, { pid: PID, build: 'b1' }, { pid: PID + 1 }, { pid: String(PID) }];
    const acted = [holder, null].flatMap((record) =>
      hellos.filter((hello) => decideTakeover(PID, record, hello).action !== 'none').map((hello) => [record, hello]),
    );
    expect(acted).toEqual([
      [holder, { pid: PID }],
      [holder, { pid: PID, build: 'b1' }],
    ]);
  });
});
