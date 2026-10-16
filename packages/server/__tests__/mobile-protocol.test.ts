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
  | 'desktop.gc.subscribe'
  | 'desktop.plan.get'
  | 'desktop.plan.cancel'
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
        | Server.DesktopGcProgressEvent['event']
        | Server.DesktopGcEndedEvent['event']
      >
    >().toEqualTypeOf<Mobile.ServerEvent['event']>();
    expectTypeOf<WithoutRecords<Server.LogsEvent>>().toExtend<WithoutRecords<Mobile.LogsEvent>>();
    expectTypeOf<Mobile.LogRecord>().toExtend<Server.LogRecord>();
  });
});

test('Gradle artifact offers and downloads require a complete query with a resolved variant on the wire', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const accepts = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const query = {
    project: '',
    sourceDigest: 'a'.repeat(64),
    inputs: { complete: true, ignored: [], outputs: ['build'] },
    android: { variant: 'debug', abi: null, compilerCache: 'none', gradleBuildCache: true, pch: 'auto' },
  };
  const artifact = { fingerprint: 'b'.repeat(64), cacheKey: 'worker-key' };
  for (const method of ['build.offer', 'build.cached-artifact']) {
    const params = method === 'build.offer' ? { repo: 'app-1', native: 'gradle' } : { repo: 'app-1', artifact };
    expect(accepts({ id: 1, method, params: { ...params, gradleArtifact: query } })).toBe(true);
    for (const invalid of [
      { ...query, android: { ...query.android, variant: null } },
      { ...query, inputs: { ignored: [], outputs: [] } },
      { ...query, sourceDigest: 'not-a-digest' },
      { ...query, receipt: { privateFile: '/private/signing.jks' } },
    ])
      expect(accepts({ id: 1, method, params: { ...params, gradleArtifact: invalid } })).toBe(false);
  }
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
  for (const platform of ['ios', 'android', 'macos'])
    expect(accepts({ cwd: '/app', platform, request: 'preview_1' })).toBe(true);
  for (const platform of ['ios', 'android']) expect(accepts({ cwd: '/app', platform, slot: 'preview' })).toBe(true);
  for (const params of [
    { cwd: '/app', platform: 'macos', slot: 'preview' },
    { cwd: '/app', platform: 'web' },
    { cwd: '/app', platform: 'ios', slot: '--device' },
    { cwd: '/app', platform: 'ios', extra: true },
  ])
    expect(accepts(params)).toBe(false);
  for (const request of ['', 'a'.repeat(129), '../other', 7])
    expect(accepts({ cwd: '/app', platform: 'ios', request })).toBe(false);
  const cancel = (params: unknown) => acceptsRequest({ id: 1, method: 'desktop.plan.cancel', params });
  expect(cancel({ request: 'preview_1' })).toBe(true);
  for (const params of [{}, { request: '' }, { request: '../other' }, { request: 7 }, { request: 'a', cwd: '/app' }])
    expect(cancel(params)).toBe(false);
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

test('the private GC wire schema accepts scoped cleanup selectors and refuses malformed effects', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const accepts = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const request = (params: unknown) => ({ id: 1, method: 'desktop.gc.subscribe', params });
  expect(accepts(request({ cwd: '/app' }))).toBe(true);
  expect(
    accepts(
      request({ cwd: '/app', cache: 'archived:history', olderThan: 7, worktrees: true, delete: true, idleMs: 1000 }),
    ),
  ).toBe(true);
  for (const params of [
    {},
    { cwd: '/app', cache: ' ' },
    { cwd: '/app', cache: 7 },
    { cwd: '/app', delete: 'yes' },
    { cwd: '/app', worktrees: 1 },
    { cwd: '/app', olderThan: 1.5 },
    { cwd: '/app', idleMs: 0 },
    { cwd: '/app', olderThan: Number.MAX_SAFE_INTEGER + 1 },
    { cwd: '/app', idleMs: Number.MAX_SAFE_INTEGER + 1 },
    { cwd: '/app', signal: {} },
  ])
    expect(accepts(request(params))).toBe(false);
});
