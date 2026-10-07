import Ajv2020 from 'ajv/dist/2020.js';
import { protocolJsonSchema } from '../src/protocol.ts';
import type * as Mobile from '../../../apps/mobile/src/protocol/types.ts';
import type * as Server from '../src/protocol.ts';

type BuildMethod = (typeof Server.BUILD_METHODS)[number];

type DeviceHostMethod = (typeof Server.DEVICE_HOST_METHODS)[number];
type ServerUpdateMethod = (typeof Server.SERVER_UPDATE_METHODS)[number];
type PhoneMethod = Exclude<
  keyof Server.Methods,
  | BuildMethod
  | DeviceHostMethod
  | ServerUpdateMethod
  | 'route.setup'
  | 'machines.update.start'
  | 'machines.update.status'
  | 'device-host.sessions'
  | 'device-host.sessions.stop'
>;

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

test('the wire schema accepts person-side session queries and stops while refusing ambiguous params and phases', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const acceptsResponse = validator.compile({ $ref: 'protocol#/$defs/ServerResponse' });
  const acceptsStop = validator.compile({ $ref: 'protocol#/$defs/HostedSessionStopResult' });
  for (const request of [
    { id: 1, method: 'device-host.sessions' },
    { id: 1, method: 'device-host.sessions', params: {} },
    { id: 1, method: 'device-host.sessions.stop', params: { session: 'session-id' } },
  ])
    expect(acceptsRequest(request)).toBe(true);
  for (const request of [
    { id: 1, method: 'device-host.sessions', params: { session: 'session-id' } },
    { id: 1, method: 'device-host.sessions.stop' },
    { id: 1, method: 'device-host.sessions.stop', params: { session: 1 } },
    { id: 1, method: 'device-host.sessions.stop', params: { session: 'session-id', client: 'other' } },
  ])
    expect(acceptsRequest(request)).toBe(false);
  expect(acceptsResponse({ id: 1, result: { sessions: [] } })).toBe(true);
  for (const state of ['stopping', 'stopped']) {
    const result = { id: 'session-id', state };
    expect(acceptsStop(result)).toBe(true);
    expect(acceptsResponse({ id: 1, result })).toBe(true);
  }
  expect(acceptsStop({ id: 'session-id', state: 'ready' })).toBe(false);
});
