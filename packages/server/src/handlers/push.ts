import { PUSH_TOKEN_PATTERN, type RequestId, PUSH_EVENTS, NOTIFICATION_LEVELS } from '../protocol.ts';
import { send, type ConnectionContext } from './context.ts';
import {
  type PairedDevice,
  parseQuietHours,
  parseLevels,
  validStuckMinutes,
  setDevicePush,
  pushEvents,
} from '../registry.ts';
import { isJsonObject } from '@stim-cli/core/state';
import { DEFAULT_STUCK_MINUTES } from '@stim-cli/core/oversight';

const pushToken = new RegExp(PUSH_TOKEN_PATTERN);

export function registerPush(ctx: ConnectionContext, id: RequestId, params: unknown, session: PairedDevice): void {
  const value = isJsonObject(params) ? params : {};
  const { token, events, ref } = value;
  const agentOnly = value.agentOnly ?? false;
  const stuckMinutes = value.stuckMinutes ?? DEFAULT_STUCK_MINUTES;
  const quietHours = value.quietHours === undefined ? null : parseQuietHours(value.quietHours);
  const levels = value.levels === undefined ? undefined : parseLevels(value.levels);
  if (
    typeof token !== 'string' ||
    !pushToken.test(token) ||
    !Array.isArray(events) ||
    events.length === 0 ||
    !events.every((event) => (PUSH_EVENTS as readonly unknown[]).includes(event)) ||
    typeof agentOnly !== 'boolean' ||
    typeof ref !== 'string' ||
    ref.length === 0 ||
    ref.length > 128 ||
    !validStuckMinutes(stuckMinutes) ||
    (value.quietHours !== undefined && quietHours === null) ||
    levels === null
  ) {
    return ctx.error(
      id,
      'bad-request',
      'push.register takes an Expo push token, one or more events from ' +
        `${PUSH_EVENTS.join(', ')}, a ref of 1 to 128 characters, and optionally stuckMinutes from 1 to 240 and ` +
        'quietHours { start, end, timeZone } in minutes after midnight and an IANA time zone, and levels ' +
        `mapping events to ${NOTIFICATION_LEVELS.join(' or ')}.`,
    );
  }
  const registered = setDevicePush(session.id, {
    token,
    events: pushEvents(events),
    ...(levels ? { levels } : {}),
    ref,
    registeredAt: new Date().toISOString(),
    stuckMinutes,
    quietHours,
  });
  if (!registered) return ctx.error(id, 'unauthorized', 'This device is no longer paired.');
  ctx.push.refresh();
  send(ctx.socket, { id, result: {} });
}
