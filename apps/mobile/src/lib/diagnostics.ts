import * as Sentry from '@sentry/react-native';

import { ERROR_CODES } from '@stim-cli/core/protocol';
import type { RpcIssue } from '@stim-cli/core/receive-protocol';

export type Failure =
  | { kind: 'rpc'; stage: 'parse' | 'envelope' | 'result' | 'event' | 'error'; name: string; issue: RpcIssue | null }
  | { kind: 'pairing' | 'connection'; errorClass: string };

export interface FailureReport {
  message: string;
  tags: Record<string, string>;
  fingerprint: string[];
}

/** An error code from the Mac, kept only when the protocol defines it. */
export function safeName(value: unknown): string {
  return ERROR_CODES.some((code) => code === value) ? (value as string) : 'other';
}

/** Only the stage, the protocol name and the schema location of a failure. Never a value from the Mac. */
export function describeFailure(failure: Failure): FailureReport {
  if (failure.kind === 'rpc') {
    const tags: Record<string, string> = { stage: failure.stage, name: failure.name };
    const fingerprint = ['rpc', failure.stage, failure.name];
    if (failure.issue) {
      tags.keyword = failure.issue.keyword;
      tags.schema_path = failure.issue.schemaPath;
      fingerprint.push(failure.issue.keyword, failure.issue.schemaPath);
      if (failure.issue.missingProperty) {
        tags.missing_property = failure.issue.missingProperty;
        fingerprint.push(failure.issue.missingProperty);
      }
      if (failure.issue.expectedType) tags.expected_type = failure.issue.expectedType;
    }
    return { message: 'rpc-validation-failed', tags, fingerprint };
  }
  return {
    message: failure.kind === 'pairing' ? 'pairing-failed' : 'connection-failed',
    tags: { error_class: failure.errorClass },
    fingerprint: [failure.kind, failure.errorClass],
  };
}

/** Sends each distinct failure once, and at most `max` in all. */
export function createFailureReporter(capture: (report: FailureReport) => void, max = 20) {
  const seen = new Set<string>();
  return (failure: Failure) => {
    const report = describeFailure(failure);
    const key = report.fingerprint.join('|');
    if (seen.size >= max || seen.has(key)) return;
    seen.add(key);
    capture(report);
  };
}

/** Sentry drops these calls unless `src/lib/sentry.ts` initialized it, which needs a DSN. */
export const reportFailure = createFailureReporter((report) => {
  Sentry.captureMessage(report.message, { level: 'warning', tags: report.tags, fingerprint: report.fingerprint });
});

/** `route` is the route pattern, such as `mac/[id]/workspace`, never the values that fill its parameters. */
export function addNavigationBreadcrumb(route: string): void {
  Sentry.addBreadcrumb({ category: 'navigation', level: 'info', message: route || '/' });
}
