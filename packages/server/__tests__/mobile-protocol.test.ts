import type * as Mobile from '../../../apps/mobile/src/protocol/types.ts';
import type * as Server from '../src/protocol.ts';

type SharedMethod = keyof Server.Methods & keyof Mobile.Methods;

type ParamsTheServerRefuses = {
  [M in SharedMethod]: Mobile.Methods[M]['params'] extends Server.Methods[M]['params'] ? never : M;
}[SharedMethod];

type WithoutRecords<T> = T extends { records: unknown } ? Omit<T, 'records'> : T;

type ResultsTheAppMisreads = {
  [M in SharedMethod]: WithoutRecords<Server.Methods[M]['result']> extends WithoutRecords<Mobile.Methods[M]['result']>
    ? never
    : M;
}[SharedMethod];

describe('the mobile app protocol copy', () => {
  it('knows every server method and sends params the server accepts', () => {
    expectTypeOf<Exclude<keyof Server.Methods, keyof Mobile.Methods>>().toBeNever();
    expectTypeOf<ParamsTheServerRefuses>().toBeNever();
    expectTypeOf<typeof Mobile.PROTOCOL_VERSION>().toEqualTypeOf<typeof Server.PROTOCOL_VERSION>();
  });

  it('reads every result and event the server sends', () => {
    expectTypeOf<ResultsTheAppMisreads>().toBeNever();
    expectTypeOf<Server.StatusEvent>().toExtend<Mobile.StatusEvent>();
    expectTypeOf<Server.ErrorEvent>().toExtend<Mobile.ErrorEvent>();
    expectTypeOf<WithoutRecords<Server.LogsEvent>>().toExtend<WithoutRecords<Mobile.LogsEvent>>();
    expectTypeOf<Mobile.LogRecord>().toExtend<Server.LogRecord>();
  });
});
