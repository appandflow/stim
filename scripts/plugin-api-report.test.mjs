import { expect, test } from 'vitest';
import { apiReportVerdict, normalizeDeclarations } from './plugin-api-report.mjs';

const declarations = ({ version = 1, cacheVersion = 1, members = [], files = [], exports = [], timeout = '1e4' }) =>
  `//#region ../cache/dist/provider-core-Zz99.d.mts\r
declare const CACHE_PROVIDER_API_VERSION: ${cacheVersion};\r
declare const PROVIDER_LOAD_TIMEOUT_MS = ${timeout};\r
interface FileCacheCapability {
  stat?(input: {
    key: string;
  }): Promise<{
${files.map((line) => `    ${line}`).join('\n')}
  } | null>;
}
//#endregion
//#region ../transport/dist/index-Ab12Cd.d.mts
declare const TRANSPORT_API_VERSION: ${version};
/** A transport. */
interface Transport$1 {
\tid: string;
${members.map((line) => `\t${line}`).join('\n')}
}
//#endregion
export { CACHE_PROVIDER_API_VERSION, type FileCacheCapability, TRANSPORT_API_VERSION, type Transport$1 as Transport, ${exports.join(', ')} };
`;

const note = (text) => `# Unreleased\n\n## Removed (breaking)\n\n- stim/plugin: ${text}\n`;

const plugin = (options, baseline, notes = '') =>
  apiReportVerdict({
    baseline: normalizeDeclarations(declarations(baseline)),
    current: normalizeDeclarations(declarations(options)),
    notes,
    produced: 'implemented',
  }).status;

const root = ({ version = 1, start = [], client = [], device = [] }) =>
  normalizeDeclarations(`declare const STIM_API_VERSION: ${version};
interface StimStartOptions {
  waitSeconds?: number;
${start.map((line) => `  ${line}`).join('\n')}
}
interface DeviceToolOptions {
  udid: string;
${device.map((line) => `  ${line}`).join('\n')}
}
type StimBuildOptions = {
  platform: "ios";
  buildCache?: boolean;
} | {
  platform: "android";
  buildCache?: boolean;
};
interface StimClient {
  start(options?: StimStartOptions): Promise<void>;
  build(options: StimBuildOptions): Promise<void>;
  /** @internal For stim-server. */
  deviceTool(options: DeviceToolOptions): Promise<void>;
${client.map((line) => `  ${line}`).join('\n')}
}
export { STIM_API_VERSION, type StimBuildOptions, type StimClient, type StimStartOptions };
`);

const stim = (current, baseline, notes = '') =>
  apiReportVerdict({ baseline, current, notes, untagged: 'stim', produced: 'arguments' });

test('the report keeps types, drops values, comments, region hashes and bundler suffixes, and names each kind', () => {
  const report = normalizeDeclarations(declarations({ members: ['close?(): Promise<void>;'] }));
  expect(report).toContain('[transport] interface Transport { @@1 close?(): Promise<void>;');
  expect(report).toContain('[transport] export type Transport as Transport');
  expect(report).toContain('[cache-provider] declare const PROVIDER_LOAD_TIMEOUT_MS;');
  expect(report).toContain('[cache-provider] interface FileCacheCapability { @@2p key: string;');
  expect(report.join('\n')).not.toMatch(/Zz99|Ab12Cd|A transport|\$1|1e4|\r/);
  expect(normalizeDeclarations(declarations({ members: ['close?(): Promise<void>;'], timeout: '2e4' }))).toEqual(
    report,
  );
});

test('an added member or export is additive', () => {
  expect(
    plugin({ members: ['close?(): Promise<void>;', 'watch?(): void;'] }, { members: ['close?(): Promise<void>;'] }),
  ).toBe('additive');
});

test('a changed member breaks unless its own kind integer goes up and the notes name the new integer', () => {
  const baseline = { members: ['close?(): Promise<void>;'] };
  const changed = { members: ['close?(): void;'] };
  expect(plugin(changed, baseline, note('transport 1'))).toBe('breaking');
  expect(plugin({ ...changed, cacheVersion: 2 }, baseline, note('cache-provider 2'))).toBe('breaking');
  expect(plugin({ ...changed, version: 2 }, baseline, note('an older break'))).toBe('breaking');
  expect(plugin({ ...changed, version: 2 }, baseline, note('transport 21'))).toBe('breaking');
  expect(plugin({ ...changed, version: 2 }, baseline, note('`close` returns void, transport 2'))).toBe('accepted');
});

test('a new required member of an implemented interface, or of an object it returns, breaks; one in its input does not', () => {
  const baseline = { members: ['expose(input: {', '  port: number;', '}): Promise<void>;'], files: ['size: number;'] };
  const kept = ['expose(input: {', '  port: number;'];
  expect(plugin({ ...baseline, members: [...kept, '  path: string;', '}): Promise<void>;'] }, baseline)).toBe(
    'additive',
  );
  expect(plugin({ ...baseline, members: [...baseline.members, 'watch?(): void;'] }, baseline)).toBe('additive');
  expect(plugin({ ...baseline, files: ['size: number;', 'etag?: string;'] }, baseline)).toBe('additive');
  expect(plugin({ ...baseline, members: [...baseline.members, 'watch(): void;'] }, baseline)).toBe('breaking');
  expect(plugin({ ...baseline, files: ['size: number;', 'etag: string;'] }, baseline)).toBe('breaking');
  expect(
    plugin(
      { ...baseline, members: [...baseline.members, 'watch(): void;'], version: 2 },
      baseline,
      note('transport 2'),
    ),
  ).toBe('accepted');
  expect(
    apiReportVerdict({ baseline: [], current: normalizeDeclarations(declarations(baseline)), notes: '' }).status,
  ).toBe('additive');
});

test('a new required member of a type a caller passes in breaks; one of a type Stim returns does not', () => {
  const baseline = root({});
  expect(stim(root({ start: ['projectName: string;'] }), baseline).status).toBe('breaking');
  expect(stim(root({ start: ['projectName?: string;'] }), baseline).status).toBe('additive');
  expect(stim(root({ client: ['identity(): Promise<{', '  id: string;', '}>;'] }), baseline).status).toBe('additive');
});

test('removing a member from one union branch breaks even when another branch keeps the same member', () => {
  const baseline = root({});
  const report = baseline.filter((line) => !/StimBuildOptions = \{ @branch1 @@1 buildCache/.test(line));
  expect(report).toHaveLength(baseline.length - 1);
  expect(baseline.every((line) => !line.startsWith('[*] } | {'))).toBe(true);
  expect(stim(report, baseline).status).toBe('breaking');
});

test('an optional parameter, a wider union or a new enum value is additive; a narrower one breaks', () => {
  const baseline = root({ client: ['stop(options?: string): Promise<"ok" | "failed">;', 'level?: "info" | "warn";'] });
  const changed = (client) => stim(root({ client }), baseline).status;
  expect(
    changed(['stop(options?: string, slot?: string): Promise<"ok" | "failed">;', 'level?: "info" | "warn";']),
  ).toBe('additive');
  expect(changed(['stop(options?: string): Promise<"ok" | "failed">;', 'level?: "info" | "warn" | "error";'])).toBe(
    'additive',
  );
  expect(changed(['stop(options?: string, slot: string): Promise<"ok" | "failed">;', 'level?: "info" | "warn";'])).toBe(
    'breaking',
  );
  expect(changed(['stop(options?: string): Promise<"ok" | "failed">;', 'level?: "info";'])).toBe('breaking');
});

test('a change under @internal, or to a type only @internal members reach, is additive and still refreshes the report', () => {
  const baseline = root({});
  const changed = baseline.filter((line) => !/DeviceToolOptions \{ @@1 udid/.test(line));
  expect(changed).toHaveLength(baseline.length - 1);
  expect(stim(changed, baseline).status).toBe('additive');
  const without = baseline.filter((line) => !/deviceTool/.test(line));
  expect(stim(without, baseline).status).toBe('additive');
});

test('only a doc comment that starts with @internal marks a line internal', () => {
  const report = normalizeDeclarations(
    declarations({
      members: ['/** Host only. @internal */', 'close?(): Promise<void>;', '/** @internal */', 'watch?(): void;'],
    }),
  );
  expect(report).toContain('[transport] interface Transport { @@1 close?(): Promise<void>;');
  expect(report).toContain('[transport] interface Transport { @@1 @internal watch?(): void;');
});

test('a changed line of the stim report needs the stim integer, not a plugin kind integer', () => {
  const baseline = root({ client: ['gc(): Promise<void>;'] });
  const verdict = (version, notes) => stim(root({ version, client: ['gcReport(): Promise<void>;'] }), baseline, notes);
  expect(verdict(1, '')).toMatchObject({ status: 'breaking', needs: ['a bump of the stim integer (now 1)'] });
  expect(verdict(2, note('`gc` is `gcReport`, stim 2')).status).toBe('accepted');
});
