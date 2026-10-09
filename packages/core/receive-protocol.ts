import type { Method, Methods, ProtocolError, ServerEvent } from './phone-protocol.ts';
import { responses, event, error, eventNames } from './receive-validators.mjs';

/** Validates a result against the method of its pending request without changing the payload. */
export function isRpcResult<M extends Method>(method: M, value: unknown): value is Methods[M]['result'] {
  return responses[method](value);
}

/** Validates a known phone event, including its nested payload. */
export function isRpcEvent(value: unknown): value is ServerEvent {
  return event(value);
}

/** Accepts future error codes while requiring a usable code and message. */
export function isRpcError(value: unknown): value is ProtocolError {
  return error(value);
}

/** Unknown future events can be ignored without reconnecting to a newer server. */
export function isRpcEventName(value: string): boolean {
  return eventNames.includes(value);
}

/** Why a validator rejected a value, described by the schema alone: no instance path and no value. */
export interface RpcIssue {
  keyword: string;
  schemaPath: string;
  missingProperty?: string;
  expectedType?: string;
}

type AjvError = { keyword?: unknown; schemaPath?: unknown; params?: { missingProperty?: unknown; type?: unknown } };
type Validator = ((value: unknown) => boolean) & { errors?: AjvError[] | null };

const SCHEMA_PATH = /^#[\w/.$~-]{0,200}$/;
const WORD = /^\w{1,40}$/;

function issueOf(validator: Validator, value: unknown): RpcIssue | null {
  if (validator(value)) return null;
  const first = validator.errors?.[0];
  const issue: RpcIssue = {
    keyword: typeof first?.keyword === 'string' && WORD.test(first.keyword) ? first.keyword : 'unknown',
    schemaPath: typeof first?.schemaPath === 'string' && SCHEMA_PATH.test(first.schemaPath) ? first.schemaPath : '',
  };
  const missing = first?.params?.missingProperty;
  if (typeof missing === 'string' && WORD.test(missing)) issue.missingProperty = missing;
  const expected = first?.params?.type;
  if (typeof expected === 'string' && WORD.test(expected)) issue.expectedType = expected;
  return issue;
}

/** The first schema violation of a result for `method`, or null when it is valid. */
export function rpcResultIssue<M extends Method>(method: M, value: unknown): RpcIssue | null {
  return issueOf(responses[method] as Validator, value);
}

/** The first schema violation of a phone event, or null when it is valid. */
export function rpcEventIssue(value: unknown): RpcIssue | null {
  return issueOf(event as Validator, value);
}

/** The first schema violation of an RPC error object, or null when it is valid. */
export function rpcErrorIssue(value: unknown): RpcIssue | null {
  return issueOf(error as Validator, value);
}
