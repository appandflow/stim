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
