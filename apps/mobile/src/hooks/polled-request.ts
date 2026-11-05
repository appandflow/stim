import { useCallback, useEffect, useRef, useState } from 'react';

import { RequestError, type StimConnection } from '@/lib/connection';
import type { Method, Methods } from '@/protocol/types';

export interface PolledRequestOptions<M extends Method> {
  /** Asks again on this interval; without it the request is sent once per activation. */
  intervalMs?: number;
  /** Requests are sent only while this holds. */
  active: boolean;
  /** Called with each answer that is not older than one already delivered. */
  onData?: (data: Methods[M]['result']) => void;
  /** Called with each failure. */
  onError?: (error: Error) => void;
}

export interface PolledRequest<M extends Method> {
  /** The latest answer for these params, kept across failures and while inactive. */
  data: Methods[M]['result'] | null;
  /** The last request's failure, cleared by the next answer. */
  error: Error | null;
  /** Sends the request now, outside the interval. */
  refetch: () => void;
}

/**
 * Sends `method` when `active` turns on and each `intervalMs` while it stays on. An answer older than one
 * already delivered, or one arriving after the effect ended, is dropped. A server that answers `unknown-method`
 * stops the interval.
 */
export function usePolledRequest<M extends Method>(
  connection: StimConnection | null,
  method: M,
  params: Methods[M]['params'],
  { intervalMs, active, onData, onError }: PolledRequestOptions<M>,
): PolledRequest<M> {
  const key = `${method}\n${JSON.stringify(params)}`;
  const [answer, setAnswer] = useState<{ key: string; data: Methods[M]['result'] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: Error } | null>(null);
  const latest = useRef({ params, onData, onError });
  const poll = useRef<(() => void) | null>(null);

  useEffect(() => {
    latest.current = { params, onData, onError };
  });

  useEffect(() => {
    if (!connection || !active) return;
    let cancelled = false;
    const order = { sent: 0, shown: 0 };
    const ask = () => {
      order.sent += 1;
      const sequence = order.sent;
      connection.request(method, latest.current.params).then(
        (data) => {
          if (cancelled || sequence < order.shown) return;
          order.shown = sequence;
          setAnswer({ key, data });
          setFailure(null);
          latest.current.onData?.(data);
        },
        (error: Error) => {
          if (cancelled) return;
          if (error instanceof RequestError && error.error.code === 'unknown-method') clearInterval(timer);
          setFailure({ key, error });
          latest.current.onError?.(error);
        },
      );
    };
    poll.current = ask;
    const timer = intervalMs === undefined ? undefined : setInterval(ask, intervalMs);
    ask();
    return () => {
      cancelled = true;
      poll.current = null;
      clearInterval(timer);
    };
  }, [connection, method, key, intervalMs, active]);

  const refetch = useCallback(() => poll.current?.(), []);
  return {
    data: answer?.key === key ? answer.data : null,
    error: failure?.key === key ? failure.error : null,
    refetch,
  };
}
