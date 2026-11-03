import { pollStatus, setup } from '../phases.mjs';

export async function runCheck(ctx) {
  await setup(ctx, ctx.opts.workspaces);
  for (const workspace of ctx.workspaces) workspace.role = 'workspace';
  await pollStatus(ctx);
  ctx.assertions.pass('check', 'worktrees', 'worktrees are created, warmed, repaired and share one fingerprint', [
    `${ctx.workspaces.length} worktrees at ${ctx.commit.slice(0, 9)}, fingerprint ${ctx.fingerprint}`,
  ]);
  const { dormant } = ctx.clocks;
  const lines = [
    `idle clock window: ${Math.round(ctx.idleWindowMs / 60000)} min via ${ctx.clocks.idleKeys.join(' and ')}`,
  ];
  if (dormant.minutes !== null) {
    lines.push(
      dormant.available
        ? `dormant clock set to ${dormant.minutes} min`
        : `dormant clock not available on this build: ${dormant.reason}`,
    );
  }
  const wanted = ctx.opts.idleMinutes === null ? null : ctx.opts.idleMinutes * 60_000;
  const readable = ctx.clocks.idleWindowMs !== null && (wanted === null || ctx.clocks.idleWindowMs === wanted);
  (readable ? ctx.assertions.pass : ctx.assertions.fail)('check', 'clocks', 'the idle clock can be set and read back', [
    ...lines,
    ...ctx.clocks.notes,
  ]);
}
