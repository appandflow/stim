import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invocation } from '../stimd/forwarded.ts';

const failure = vi.hoisted(() => new Error('configuration could not be read'));
vi.mock('../stimd/metro/children.ts', async (original) => ({
  ...(await original<typeof import('../stimd/metro/children.ts')>()),
  ensureMetro: () => Promise.reject(failure),
}));

test('a rejected preparation stays handled until wait, and after its owner disconnects', async () => {
  const { createMetroTickets } = await import('../stimd/metro/tickets.ts');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-ticket-')));
  const owner = new Socket();
  const context = invocation(root, {});
  if ('code' in context) throw new Error(context.message);
  const tickets = createMetroTickets(() => {});
  try {
    const first = tickets.prepare(owner, { root }, { ...context, workspace: root }, new AbortController().signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(tickets.wait(first, owner)).rejects.toBe(failure);
    tickets.prepare(owner, { root }, { ...context, workspace: root }, new AbortController().signal);
    tickets.drop(owner);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    owner.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});
