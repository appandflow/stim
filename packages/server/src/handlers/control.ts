import {
  AUDIT_FIELD_CHARS,
  auditSafely,
  registeredWorkspace,
  viewHostedPlacement,
  send,
  INPUT_METHODS,
  type ConnectionContext,
} from './context.ts';
import { type RequestId, type ErrorCode, MAX_INPUT_TEXT } from '../protocol.ts';
import type { PairedDevice } from '../registry.ts';
import { isJsonObject } from '@stim-cli/core/state';
import { parseControlBegin, parseInput, CLIPBOARD_INPUT_COST, take } from '../control.ts';

const clip = (value: unknown) => (typeof value === 'string' ? value.slice(0, AUDIT_FIELD_CHARS) : null);

export async function beginControl(
  ctx: ConnectionContext,
  id: RequestId,
  params: unknown,
  session: PairedDevice,
): Promise<void> {
  const raw = isJsonObject(params) ? params : {};
  const refuseControl = (code: ErrorCode, message: string) => {
    auditSafely({
      at: new Date().toISOString(),
      device: { id: session.id, name: session.name },
      action: 'control.begin',
      workspace: clip(raw.workspace),
      ...(typeof raw.platform === 'string' ? { platform: clip(raw.platform)! } : {}),
      ...(raw.platform === 'ios' || raw.platform === 'android'
        ? { slot: typeof raw.slot === 'string' ? clip(raw.slot)! : 'default' }
        : {}),
      ok: false,
      error: { code, message: clip(message)! },
    });
    ctx.error(id, code, message);
  };
  if (!ctx.canControl(session)) {
    return refuseControl(
      'forbidden',
      `This device can only read. On the machine, run \`stim pairings grant ${session.id} --control\` to let it control devices.`,
    );
  }
  const parsed = parseControlBegin(params);
  if ('code' in parsed) return refuseControl(parsed.code, parsed.message);
  const resolved = registeredWorkspace(parsed.value.workspace);
  if ('code' in resolved) return refuseControl(resolved.code, resolved.message);
  const host = viewHostedPlacement(resolved.dir, parsed.value.platform, parsed.value.slot, parsed.value.physical);
  const owner = ctx.controller(session);
  if (host) {
    if (
      parsed.value.physical ||
      (parsed.value.platform === 'macos' && parsed.value.slot !== undefined && parsed.value.slot !== 'default')
    ) {
      return refuseControl(
        'bad-request',
        parsed.value.platform === 'ios'
          ? 'Hosted iOS control requires a non-physical target.'
          : parsed.value.platform === 'android'
            ? 'Hosted Android control requires a non-physical target.'
            : 'Hosted macOS control requires the default, non-physical target.',
      );
    }
    return ctx.relay.begin(
      id,
      host,
      parsed.value.takeOver === true,
      () =>
        ctx.socket.readyState === ctx.socket.OPEN &&
        ctx.controllers.get(ctx.socket) === owner &&
        ctx.canControl(session),
      {
        workspace: resolved.dir,
        device: { id: session.id, name: session.name },
        platform: parsed.value.platform as 'ios' | 'android' | 'macos',
        slot: parsed.value.slot,
      },
    );
  }
  const outcome = await ctx.control.begin(
    owner,
    { ...parsed.value, workspace: resolved.dir },
    resolved.dir,
    () =>
      ctx.socket.readyState === ctx.socket.OPEN && ctx.controllers.get(ctx.socket) === owner && ctx.canControl(session),
  );
  if ('code' in outcome) return refuseControl(outcome.code, outcome.message);
  send(ctx.socket, { id, result: outcome });
}

export async function input(
  ctx: ConnectionContext,
  id: RequestId,
  method: (typeof INPUT_METHODS)[number],
  params: unknown,
  session: Pick<PairedDevice, 'id' | 'name'>,
): Promise<void> {
  const owner = ctx.controller(session);
  const parsed = parseInput(method, params, (name) => ctx.relay.targetOf(name) ?? ctx.control.targetOf(owner, name));
  if ('code' in parsed) return ctx.error(id, parsed.code, parsed.message);
  const { command: sent } = parsed.value;
  const cost = sent.input === 'clipboard' || sent.input === 'clipboard-get' ? CLIPBOARD_INPUT_COST : 1;
  const boundary = sent.input === 'touch' && (sent.phase === 'down' || sent.phase === 'up');
  const debt = boundary ? ctx.controlLimits.inputPerSecond : 0;
  if (!take(ctx.inputs, cost, ctx.controlLimits.inputPerSecond, ctx.controlLimits.inputPerSecond, debt)) {
    return ctx.error(
      id,
      'limit-exceeded',
      `A connection can send ${ctx.controlLimits.inputPerSecond} inputs a second.`,
    );
  }
  if (
    sent.input === 'text' &&
    !take(ctx.characters, sent.text.length, ctx.controlLimits.textCharsPerSecond, MAX_INPUT_TEXT)
  ) {
    return ctx.error(
      id,
      'limit-exceeded',
      `A connection can type ${ctx.controlLimits.textCharsPerSecond} characters a second. Send the rest shortly.`,
    );
  }
  const { shapeChangesPerSecond } = ctx.controlLimits;
  if (
    (sent.input === 'rotate' || sent.input === 'posture' || sent.input === 'simulator') &&
    !take(ctx.shapeChanges, 1, shapeChangesPerSecond, shapeChangesPerSecond)
  ) {
    return ctx.error(id, 'limit-exceeded', `A connection can rotate or fold ${shapeChangesPerSecond} times a second.`);
  }
  if (ctx.relay.control(id, method, params)) return;
  const refused = await ctx.control.input(owner, parsed.value.session, parsed.value.command);
  if (refused && 'code' in refused) return ctx.error(id, refused.code, refused.message);
  send(ctx.socket, { id, result: refused ?? {} });
}
