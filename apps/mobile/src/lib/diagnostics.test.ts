import { createFailureReporter, describeFailure, safeName, type FailureReport } from './diagnostics';

describe('describeFailure', () => {
  it('describes a validation failure by stage, name and schema location', () => {
    expect(
      describeFailure({
        kind: 'rpc',
        stage: 'result',
        name: 'hosted.status',
        issue: {
          keyword: 'required',
          schemaPath: '#/properties/sessions/items/required',
          missingProperty: 'placement',
        },
      }),
    ).toEqual({
      message: 'rpc-validation-failed',
      tags: {
        stage: 'result',
        name: 'hosted.status',
        keyword: 'required',
        schema_path: '#/properties/sessions/items/required',
        missing_property: 'placement',
      },
      fingerprint: ['rpc', 'result', 'hosted.status', 'required', '#/properties/sessions/items/required', 'placement'],
    });
  });

  it('describes a pairing or connection failure by class alone', () => {
    expect(describeFailure({ kind: 'pairing', errorClass: 'timeout' })).toEqual({
      message: 'pairing-failed',
      tags: { error_class: 'timeout' },
      fingerprint: ['pairing', 'timeout'],
    });
    expect(describeFailure({ kind: 'connection', errorClass: 'refused:unauthorized' }).tags).toEqual({
      error_class: 'refused:unauthorized',
    });
  });
});

describe('safeName', () => {
  it('keeps identifiers and replaces anything else sent by a Mac', () => {
    expect(safeName('pairing-expired')).toBe('pairing-expired');
    expect(safeName('wss://janics-mac.tail1a2b3.ts.net')).toBe('other');
    expect(safeName('/Users/janic/app')).toBe('other');
    expect(safeName('has space')).toBe('other');
    expect(safeName(7)).toBe('other');
  });
});

describe('createFailureReporter', () => {
  const failure = (errorClass: string) => ({ kind: 'connection' as const, errorClass });

  it('sends each distinct failure once and at most the cap in a session', () => {
    const sent: FailureReport[] = [];
    const report = createFailureReporter((r) => sent.push(r), 2);
    report(failure('a'));
    report(failure('a'));
    report(failure('b'));
    report(failure('c'));
    expect(sent.map((r) => r.tags.error_class)).toEqual(['a', 'b']);
  });
});
