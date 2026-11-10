import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useRef, useState } from 'react';

import { RequestError } from '@/lib/connection';
import type {
  DevicePlatform,
  DevicePosture,
  InputButton,
  InputKey,
  KeyModifier,
  SimulatorCommand,
  SimulatorOptions,
  Methods,
  RotateDirection,
  TouchPhase,
} from '@/protocol/types';

import { useMacConnection } from './machines';

const MAX_INPUT_TEXT = 256;

export type ControlState =
  | { kind: 'off'; ended?: string }
  | { kind: 'starting' }
  | { kind: 'on'; session: string; leaseSince: string | null; postures: DevicePosture[]; simulator?: SimulatorOptions }
  | { kind: 'busy'; message: string }
  | { kind: 'failed'; message: string };

export interface DeviceControl {
  /** Whether this pairing may control devices: null while not connected. */
  allowed: boolean | null;
  state: ControlState;
  begin: (takeOver?: boolean) => void;
  end: () => void;
  /** `second` adds a second finger; every phase of one gesture carries it or none does. */
  touch: (phase: TouchPhase, x: number, y: number, duoRevision?: string, second?: { x: number; y: number }) => void;
  text: (text: string) => void;
  scroll: (x: number, y: number, deltaX: number, deltaY: number) => void;
  key: (key: InputKey, modifiers?: KeyModifier[]) => void;
  selectWindow: (id: number | null) => void;
  button: (button: InputButton) => void;
  rotate: (direction: RotateDirection) => void;
  /** Rejects with the server's reason; a Duo fold takes a few seconds to settle. */
  posture: (posture: DevicePosture) => Promise<void>;
  simulator: (command: SimulatorCommand) => Promise<void>;
  /**
   * Sets the device clipboard, and with `paste` pastes it into the focused field; `typed` is set when an iOS simulator
   * typed the text instead. Rejects with the server's reason.
   */
  clipboardSet: (text: string, paste: boolean) => Promise<{ typed?: true }>;
  /** Reads the device clipboard. Rejects with the server's reason. */
  clipboardGet: () => Promise<string>;
}

type HeldState =
  | ControlState
  | {
      kind: 'on';
      session: string;
      leaseSince: string | null;
      postures: DevicePosture[];
      simulator?: SimulatorOptions;
      link: unknown;
    };

/**
 * A control session on one device. It ends when the screen unmounts, when the connection drops (the server
 * ends a disconnected client's sessions), and when the server ends it; input sent while no session is on is
 * dropped. A session lost to a dropped connection begins again, without taking over, once a connection that
 * allows control is open.
 */
export function useDeviceControl(
  workspace: string,
  platform: DevicePlatform,
  slot: string,
  physical = false,
): DeviceControl {
  const { connection, state: link } = useMacConnection();
  const allowed = link.kind === 'open' ? link.capabilities.includes('control') : null;
  const [held, setHeld] = useState<HeldState>({ kind: 'off' });
  const dropped = held.kind === 'on' && 'link' in held && held.link !== link;
  const supported =
    connection !== null &&
    (platform !== 'macos' || (link.kind === 'open' && link.hostCapabilities.includes('macos-window-control')));
  const resumes = dropped && allowed === true && supported;
  const state: ControlState = resumes
    ? { kind: 'starting' }
    : dropped
      ? { kind: 'off', ended: t`The connection dropped.` }
      : held;
  const session = state.kind === 'on' ? state.session : null;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!connection || !session) return;
    const stop = connection.onControlEnded((event) => {
      if (event.session !== session) return;
      setHeld({ kind: 'off', ended: event.message });
      if (event.reason === 'forbidden') connection.reconnect();
    });
    return () => {
      stop();
      connection.request('control.end', { session }).catch(() => {});
    };
  }, [connection, session]);

  const request = useCallback(
    (takeOver: boolean) => {
      if (!connection) return;
      const target = { workspace, platform, slot, ...(physical ? { physical } : {}) };
      connection.request('control.begin', { ...target, ...(takeOver ? { takeOver } : {}) }).then(
        (result) => {
          if (!mounted.current || result.platform !== platform) {
            connection.request('control.end', { session: result.session }).catch(() => {});
            if (mounted.current) setHeld({ kind: 'off' });
            return;
          }
          setHeld({
            kind: 'on',
            session: result.session,
            leaseSince: result.lease?.grantedAt ?? null,
            postures: result.postures.filter(
              (posture): posture is DevicePosture =>
                posture === 'folded' || posture === 'half-open' || posture === 'unfolded',
            ),
            ...(result.simulator ? { simulator: result.simulator } : {}),
            link,
          });
        },
        (cause: Error) => {
          const code = cause instanceof RequestError ? cause.error.code : null;
          if (code === 'device-busy') return setHeld({ kind: 'busy', message: cause.message });
          if (code !== 'forbidden') return setHeld({ kind: 'failed', message: cause.message });
          setHeld({ kind: 'off' });
          connection.reconnect();
        },
      );
    },
    [connection, link, workspace, platform, slot, physical],
  );
  const begin = useCallback(
    (takeOver = false) => {
      if (!supported) return;
      setHeld({ kind: 'starting' });
      request(takeOver);
    },
    [supported, request],
  );
  const end = useCallback(() => setHeld({ kind: 'off' }), []);
  const resumedOn = useRef<unknown>(null);
  useEffect(() => {
    if (!resumes || resumedOn.current === link) return;
    resumedOn.current = link;
    request(false);
  }, [resumes, link, request]);
  const send = useCallback(
    <
      M extends
        | 'input.touch'
        | 'input.text'
        | 'input.button'
        | 'input.rotate'
        | 'input.scroll'
        | 'input.key'
        | 'input.window',
    >(
      method: M,
      params: Omit<Methods[M]['params'], 'session'>,
    ) => {
      if (!connection || !session) return;
      connection.request(method, { session, ...params } as Methods[M]['params']).catch(() => {});
    },
    [connection, session],
  );
  const touch = useCallback(
    (phase: TouchPhase, x: number, y: number, duoRevision?: string, second?: { x: number; y: number }) =>
      send('input.touch', {
        phase,
        x,
        y,
        ...(second ? { x2: second.x, y2: second.y } : {}),
        ...(duoRevision ? { duoRevision } : {}),
      }),
    [send],
  );
  const text = useCallback(
    (value: string) => {
      for (let at = 0; at < value.length; at += MAX_INPUT_TEXT) {
        send('input.text', { text: value.slice(at, at + MAX_INPUT_TEXT) });
      }
    },
    [send],
  );
  const button = useCallback((value: InputButton) => send('input.button', { button: value }), [send]);
  const scroll = useCallback(
    (x: number, y: number, deltaX: number, deltaY: number) => send('input.scroll', { x, y, deltaX, deltaY }),
    [send],
  );
  const key = useCallback(
    (key: InputKey, modifiers: KeyModifier[] = []) => send('input.key', { key, modifiers }),
    [send],
  );
  const selectWindow = useCallback((window: number | null) => send('input.window', { window }), [send]);
  const rotate = useCallback((direction: RotateDirection) => send('input.rotate', { direction }), [send]);
  const posture = useCallback(
    async (value: DevicePosture) => {
      if (!connection || !session) return;
      await connection.request('input.posture', { session, posture: value });
    },
    [connection, session],
  );
  const simulator = useCallback(
    async (command: SimulatorCommand) => {
      if (!connection || !session) return;
      const result = await connection.request('input.simulator', { session, ...command });
      if (!mounted.current) return;
      setHeld((current) =>
        current.kind === 'on' && current.session === session && 'link' in current && current.link === link
          ? { ...current, simulator: result }
          : current,
      );
    },
    [connection, session, link],
  );
  const clipboardSet = useCallback(
    async (value: string, paste: boolean) => {
      if (!connection || !session) throw new Error(t`The control session ended.`);
      return connection.request('input.clipboard.set', { session, text: value, ...(paste ? { paste } : {}) });
    },
    [connection, session],
  );
  const clipboardGet = useCallback(async () => {
    if (!connection || !session) throw new Error(t`The control session ended.`);
    return (await connection.request('input.clipboard.get', { session })).text;
  }, [connection, session]);
  return {
    allowed,
    state,
    begin,
    end,
    touch,
    text,
    scroll,
    key,
    selectWindow,
    button,
    rotate,
    posture,
    simulator,
    clipboardSet,
    clipboardGet,
  };
}
