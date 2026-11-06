import { decideTakeover } from '../policy/takeover.ts';

const PID = 4100;
const holder = { pid: PID, processToken: 'token' };

describe('taking over a running daemon', () => {
  test('a holder whose hello carries build is asked to hand over that build', () => {
    expect(decideTakeover(PID, holder, { pid: PID, build: 'b1' })).toEqual({ action: 'ask-handover', build: 'b1' });
  });

  test('a holder from before handovers gets SIGTERM', () => {
    expect(decideTakeover(PID, holder, { pid: PID, version: '1.40.0' })).toEqual({ action: 'sigterm' });
  });

  test('a gone holder, a silent one and another process answering the socket are never signalled or asked to exit', () => {
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
