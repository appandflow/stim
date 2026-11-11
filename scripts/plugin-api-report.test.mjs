import { expect, test } from 'vitest';
import { apiReportVerdict, normalizeDeclarations } from './plugin-api-report.mjs';

const declarations = (members) => `//#region ../transport/dist/index-Ab12Cd.d.mts
declare const TRANSPORT_API_VERSION: ${members.version ?? 1};
/** A transport. */
interface Transport {
\tid: string;
${members.lines.map((line) => `\t${line}`).join('\n')}
}
//#endregion
export { TRANSPORT_API_VERSION, ${members.exports.join(', ')} };
`;

const BREAKING_NOTE = '# Unreleased\n\n## Removed (breaking)\n\n- stim/plugin: `Transport.close` is gone.\n';

const report = (members) => normalizeDeclarations(declarations({ exports: ['type Transport'], ...members }));

test('an added member or export is additive, and region hashes and comments are not part of the report', () => {
  const baseline = report({ lines: ['close?(): Promise<void>;'] });
  expect(baseline).toContain('interface Transport { | close?(): Promise<void>;');
  expect(baseline.some((line) => line.includes('Ab12Cd') || line.includes('A transport'))).toBe(false);
  const current = report({ lines: ['close?(): Promise<void>;', 'watch?(): void;'], exports: ['type Transport', 'x'] });
  expect(apiReportVerdict({ baseline, current, notes: '' })).toEqual({
    status: 'additive',
    added: ['export x', 'interface Transport { | watch?(): void;'],
    removed: [],
  });
});

test('a removed or changed member breaks unless the kind integer and a Removed (breaking) note change with it', () => {
  const baseline = report({ lines: ['close?(): Promise<void>;'] });
  const changed = report({ lines: ['close?(): void;'] });
  expect(apiReportVerdict({ baseline, current: changed, notes: BREAKING_NOTE }).status).toBe('breaking');
  const bumped = report({ lines: ['close?(): void;'], version: 2 });
  expect(apiReportVerdict({ baseline, current: bumped, notes: '# Unreleased\n' }).status).toBe('breaking');
  expect(apiReportVerdict({ baseline, current: bumped, notes: BREAKING_NOTE }).status).toBe('accepted');
});
