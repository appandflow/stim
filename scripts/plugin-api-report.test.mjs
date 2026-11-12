import { expect, test } from 'vitest';
import { apiReportVerdict, normalizeDeclarations } from './plugin-api-report.mjs';

const declarations = ({ version = 1, cacheVersion = 1, members = [], exports = [], timeout = '1e4' }) =>
  `//#region ../cache/dist/provider-core-Zz99.d.mts\r
declare const CACHE_PROVIDER_API_VERSION: ${cacheVersion};\r
declare const PROVIDER_LOAD_TIMEOUT_MS = ${timeout};\r
//#endregion
//#region ../transport/dist/index-Ab12Cd.d.mts
declare const TRANSPORT_API_VERSION: ${version};
/** A transport. */
interface Transport$1 {
\tid: string;
${members.map((line) => `\t${line}`).join('\n')}
}
//#endregion
export { CACHE_PROVIDER_API_VERSION, TRANSPORT_API_VERSION, type Transport$1 as Transport, ${exports.join(', ')} };
`;

const note = (text) => `# Unreleased\n\n## Removed (breaking)\n\n- stim/plugin: ${text}\n`;

test('the report keeps types, drops values, comments, region hashes and bundler suffixes, and names each kind', () => {
  const report = normalizeDeclarations(declarations({ members: ['close?(): Promise<void>;'] }));
  expect(report).toContain('[transport] interface Transport { | close?(): Promise<void>;');
  expect(report).toContain('[transport] export type Transport as Transport');
  expect(report).toContain('[cache-provider] declare const PROVIDER_LOAD_TIMEOUT_MS;');
  expect(report.join('\n')).not.toMatch(/Zz99|Ab12Cd|A transport|\$1|1e4|\r/);
  expect(normalizeDeclarations(declarations({ members: ['close?(): Promise<void>;'], timeout: '2e4' }))).toEqual(
    report,
  );
});

test('an added member or export is additive', () => {
  const baseline = normalizeDeclarations(declarations({ members: ['close?(): Promise<void>;'] }));
  const current = normalizeDeclarations(declarations({ members: ['close?(): Promise<void>;', 'watch?(): void;'] }));
  expect(apiReportVerdict({ baseline, current, notes: '' })).toMatchObject({
    status: 'additive',
    added: ['[transport] interface Transport { | watch?(): void;'],
    removed: [],
  });
});

test('a changed member breaks unless its own kind integer goes up and the notes name the new integer', () => {
  const baseline = normalizeDeclarations(declarations({ members: ['close?(): Promise<void>;'] }));
  const verdict = (options, notes) =>
    apiReportVerdict({ baseline, current: normalizeDeclarations(declarations(options)), notes }).status;
  const changed = { members: ['close?(): void;'] };
  expect(verdict(changed, note('transport 1'))).toBe('breaking');
  expect(verdict({ ...changed, cacheVersion: 2 }, note('cache-provider 2'))).toBe('breaking');
  expect(verdict({ ...changed, version: 2 }, note('an older break'))).toBe('breaking');
  expect(verdict({ ...changed, version: 2 }, note('transport 21'))).toBe('breaking');
  expect(verdict({ ...changed, version: 2 }, note('`close` returns void, transport 2'))).toBe('accepted');
});

test('a new required member of an interface a plugin implements breaks; optional and nested ones do not', () => {
  const baseline = normalizeDeclarations(
    declarations({ members: ['close?(): Promise<void>;', 'expose(input: {', '  port: number;', '}): Promise<void>;'] }),
  );
  const verdict = (members, options = {}, notes = '') =>
    apiReportVerdict({ baseline, current: normalizeDeclarations(declarations({ members, ...options })), notes }).status;
  const kept = ['close?(): Promise<void>;', 'expose(input: {', '  port: number;'];
  expect(verdict([...kept, '  host?: string;', '  path: string;', '}): Promise<void>;'])).toBe('additive');
  expect(verdict([...kept, '}): Promise<void>;', 'watch?(): void;'])).toBe('additive');
  expect(verdict([...kept, '}): Promise<void>;', 'watch(): void;'])).toBe('breaking');
  expect(verdict([...kept, '}): Promise<void>;', 'readonly name: string;'])).toBe('breaking');
  expect(verdict([...kept, '}): Promise<void>;', 'watch(): void;'], { version: 2 }, note('transport 2'))).toBe(
    'accepted',
  );
  expect(apiReportVerdict({ baseline: [], current: baseline, notes: '' }).status).toBe('additive');
});

test('a doc comment tagged @internal keeps its tag in the report', () => {
  const report = normalizeDeclarations(
    declarations({ members: ['/** Host only. @internal */', 'close?(): Promise<void>;', 'watch?(): void;'] }),
  );
  expect(report).toContain('[transport] interface Transport { | @internal close?(): Promise<void>;');
  expect(report).toContain('[transport] interface Transport { | watch?(): void;');
});

const root = (version, member) =>
  normalizeDeclarations(
    `declare const STIM_API_VERSION: ${version};\ninterface StimClient {\n\t${member}\n}\nexport { STIM_API_VERSION, type StimClient };\n`,
  );

test('a changed line of the stim report needs the stim integer, not a plugin kind integer', () => {
  const baseline = root(1, 'gc(): Promise<void>;');
  const verdict = (version, notes) =>
    apiReportVerdict({ baseline, current: root(version, 'gcReport(): Promise<void>;'), notes, untagged: 'stim' });
  expect(verdict(1, '')).toMatchObject({ status: 'breaking', needs: ['a bump of the stim integer (now 1)'] });
  expect(verdict(2, note('`gc` is `gcReport`, stim 2')).status).toBe('accepted');
});
