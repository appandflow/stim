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
  | 'desktop.authenticate'
  | 'desktop.reports.get'
  | 'desktop.reports.subscribe'
  | 'desktop.reports.invalidate'
  | 'desktop.settings.get'
  | 'desktop.settings.write'
  | 'desktop.logs.subscribe'
  | 'desktop.doctor.run'
  | 'desktop.stop.subscribe'
  | 'desktop.reload.subscribe'
  | 'desktop.start.subscribe'
  | 'desktop.run.subscribe'
  | 'desktop.build.subscribe'
  | 'desktop.plan.get'
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
    expectTypeOf<
      Exclude<
        Server.ServerEvent['event'],
        | Server.BuildProgressEvent['event']
        | Server.DesktopReportEvent['event']
        | Server.DesktopStopProgressEvent['event']
        | Server.DesktopStopEndedEvent['event']
        | Server.DesktopReloadProgressEvent['event']
        | Server.DesktopReloadEndedEvent['event']
        | Server.DesktopStartProgressEvent['event']
        | Server.DesktopStartEndedEvent['event']
        | Server.DesktopRunProgressEvent['event']
        | Server.DesktopRunEndedEvent['event']
        | Server.DesktopBuildProgressEvent['event']
        | Server.DesktopBuildEndedEvent['event']
      >
    >().toEqualTypeOf<Mobile.ServerEvent['event']>();
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

test('the wire schema validates Desktop report targets and pushed snapshots', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const acceptsEvent = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
  expect(acceptsRequest({ id: 1, method: 'desktop.reports.get', params: { report: 'gc' } })).toBe(true);
  expect(
    acceptsRequest({ id: 1, method: 'desktop.reports.subscribe', params: { report: 'doctor', cwd: '/app' } }),
  ).toBe(true);
  expect(acceptsRequest({ id: 1, method: 'desktop.reports.get', params: { report: 'doctor' } })).toBe(false);
  expect(acceptsRequest({ id: 1, method: 'desktop.reports.get', params: { report: 'gc', delete: true } })).toBe(false);
  for (const platform of ['ios', 'android']) {
    expect(
      acceptsRequest({ id: 1, method: 'desktop.reports.get', params: { report: 'doctor', cwd: '/app', platform } }),
    ).toBe(true);
  }
  for (const params of [
    { report: 'doctor', cwd: '/app', platform: 'macos' },
    { report: 'doctor', cwd: '/app', platform: null },
    { report: 'gc', platform: 'ios' },
  ])
    expect(acceptsRequest({ id: 1, method: 'desktop.reports.get', params })).toBe(false);
  const event = {
    event: 'desktop-report',
    subscription: 's1',
    target: { report: 'gc' },
    snapshot: { pending: true, value: null },
  };
  expect(acceptsEvent(event)).toBe(true);
  expect(acceptsEvent({ ...event, snapshot: { pending: false, value: [], error: 7 } })).toBe(false);
});

test.each(['desktop.settings.get', 'desktop.doctor.run'])(
  '%s requires a folder and rejects ambiguous selectors',
  (method) => {
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
    expect(acceptsRequest({ id: 1, method, params: { cwd: '/selected' } })).toBe(true);
    for (const params of [undefined, {}, { cwd: '' }, { cwd: 7 }, { cwd: '/app', workspace: '/app' }]) {
      expect(acceptsRequest({ id: 1, method, params })).toBe(false);
    }
    expect(acceptsRequest({ id: 1, method, params: { cwd: '/selected', platform: 'ios' } })).toBe(
      method === 'desktop.doctor.run',
    );
    expect(acceptsRequest({ id: 1, method, params: { cwd: '/selected', platform: 'web' } })).toBe(false);
  },
);

test('the private plan wire schema accepts native platforms and limits slots to iOS/Android', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const accepts = (params: unknown) => acceptsRequest({ id: 1, method: 'desktop.plan.get', params });
  for (const platform of ['ios', 'android', 'macos']) expect(accepts({ cwd: '/app', platform })).toBe(true);
  for (const platform of ['ios', 'android']) expect(accepts({ cwd: '/app', platform, slot: 'preview' })).toBe(true);
  for (const params of [
    { cwd: '/app', platform: 'macos', slot: 'preview' },
    { cwd: '/app', platform: 'web' },
    { cwd: '/app', platform: 'ios', slot: '--device' },
    { cwd: '/app', platform: 'ios', extra: true },
  ])
    expect(accepts(params)).toBe(false);
});

test('the settings write wire schema distinguishes set text from unset and rejects ambiguous requests', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const request = (params: unknown) => ({ id: 1, method: 'desktop.settings.write', params });
  const target = { cwd: '/selected', key: 'ios.runtime', scope: 'workspace' };
  expect(acceptsRequest(request({ ...target, action: 'set', value: '26.4' }))).toBe(true);
  expect(acceptsRequest(request({ ...target, action: 'unset' }))).toBe(true);
  for (const params of [
    undefined,
    { ...target, action: 'set' },
    { ...target, action: 'set', value: 26.4 },
    { ...target, action: 'unset', value: '26.4' },
    { ...target, action: 'unset', scope: 'all' },
    { ...target, action: 'unset', extra: true },
    { ...target, action: 'unset', key: '' },
    { ...target, action: 'unset', cwd: '' },
  ])
    expect(acceptsRequest(request(params))).toBe(false);
});
