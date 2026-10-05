import type * as Mobile from '../../../apps/mobile/src/protocol/types.ts';
import type * as Server from '../src/protocol.ts';

type BuildMethod = (typeof Server.BUILD_METHODS)[number];

type DeviceHostMethod = (typeof Server.DEVICE_HOST_METHODS)[number];
type PhoneMethod = Exclude<keyof Server.Methods, BuildMethod | DeviceHostMethod | 'route.setup'>;

type SharedMethod = PhoneMethod & keyof Mobile.Methods;

type ParamsTheServerRefuses = {
  [M in SharedMethod]: Mobile.Methods[M]['params'] extends Server.Methods[M]['params'] ? never : M;
}[SharedMethod];

type WithoutRecords<T> = T extends { records: unknown } ? Omit<T, 'records'> : T;

type ResultsTheAppMisreads = {
  [M in SharedMethod]: WithoutRecords<Server.Methods[M]['result']> extends WithoutRecords<Mobile.Methods[M]['result']>
    ? never
    : M;
}[SharedMethod];

describe('the shared phone protocol', () => {
  it('knows every server method and sends params the server accepts', () => {
    expectTypeOf<Exclude<PhoneMethod, keyof Mobile.Methods>>().toBeNever();
    expectTypeOf<Exclude<keyof Mobile.Methods, PhoneMethod>>().toBeNever();
    expectTypeOf<ParamsTheServerRefuses>().toBeNever();
    expectTypeOf<typeof Mobile.PROTOCOL_VERSION>().toEqualTypeOf<typeof Server.PROTOCOL_VERSION>();
  });

  it('reads every result and event the server sends', () => {
    expectTypeOf<ResultsTheAppMisreads>().toBeNever();
    expectTypeOf<Server.StatusEvent extends Mobile.StatusEvent ? never : 'status'>().toBeNever();
    expectTypeOf<Server.ErrorEvent>().toExtend<Mobile.ErrorEvent>();
    expectTypeOf<Server.FrameEvent>().toExtend<Mobile.FrameEvent>();
    expectTypeOf<Server.MacosWindowsEvent>().toExtend<Mobile.MacosWindowsEvent>();
    expectTypeOf<Server.FrameDelayedEvent>().toExtend<Mobile.FrameDelayedEvent>();
    expectTypeOf<Server.ReplayEndedEvent>().toExtend<Mobile.ReplayEndedEvent>();
    expectTypeOf<Server.ControlEndedEvent>().toExtend<Mobile.ControlEndedEvent>();
    expectTypeOf<Server.NotificationEvent>().toExtend<Mobile.NotificationEvent>();
    expectTypeOf<Exclude<Server.ServerEvent['event'], Server.BuildProgressEvent['event']>>().toEqualTypeOf<
      Mobile.ServerEvent['event']
    >();
    expectTypeOf<WithoutRecords<Server.LogsEvent>>().toExtend<WithoutRecords<Mobile.LogsEvent>>();
    expectTypeOf<Mobile.LogRecord>().toExtend<Server.LogRecord>();
  });
});
