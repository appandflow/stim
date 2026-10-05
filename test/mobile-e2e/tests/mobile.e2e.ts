import { test } from '@e2e-dev/mobile';
import { expect, type TestFixtures } from 'e2e';

type Move = (goal: string, exact: () => Promise<void>) => Promise<unknown>;
type Flow = (fixtures: Pick<TestFixtures, 'app' | 'screen'>, move: Move) => Promise<void>;

function pilot(title: string, flow: Flow) {
  if (process.env.PILOT_AI === '1') {
    test(title, async ({ app, agent, screen }) => flow({ app, screen }, (goal) => agent.act(goal)));
  } else {
    test(title, async ({ app, screen }) => flow({ app, screen }, (_goal, exact) => exact()));
  }
}

pilot('compact drawer survives a sheet and workspace Back', async ({ app, screen }, move) => {
  await app.open();
  const menu = screen.getByRole('button', /^Menu(?:,|$)/);
  const workspaces = screen.getByRole('button', 'Workspaces', { visible: true });
  await move('Open the Menu', () => menu.tap());
  await expect(workspaces).toBeVisible();
  const drawer = await workspaces.boundingBox();
  await move('Open Pair a machine from the open menu', () =>
    screen.getByRole('button', 'Pair a machine', { visible: true }).last().tap(),
  );
  await expect(screen.getByRole('button', 'Close')).toBeVisible();
  await move('Close the pairing sheet without pairing a machine', () => screen.getByRole('button', 'Close').tap());
  await expect(workspaces).toBeVisible();
  expect(await workspaces.boundingBox()).toEqual(drawer);
  await move('Choose Workspaces in the menu', () => workspaces.tap());
  const row = screen.getByRole('button', /^a4-running,/);
  await expect(row).toBeVisible();
  await move('Open workspace a4-running', () => row.tap());
  await expect(screen.getByRole('button', 'More')).toBeVisible();
  await move('Go Back to the workspace list', () => app.back());
  await expect(row).toBeVisible();
  await expect(menu).toBeVisible();
});

pilot('notification category filtering and mark-read update the actual rows', async ({ app, screen }, move) => {
  await app.open();
  await move('Open the Menu', () => screen.getByRole('button', /^Menu(?:,|$)/).tap());
  await expect(screen.getByRole('button', /^Notifications(?:,|$)/)).toBeVisible();
  await move('Open Notifications', () => screen.getByRole('button', /^Notifications(?:,|$)/).tap());
  const filter = screen.getByRole('button', 'Filter and mark read');
  const stuck = screen.getByRole('button', /No agent activity for 15 min/);
  const started = screen.getByRole('button', /agent-device started driving/);
  await expect(stuck.first()).toBeVisible();
  await expect(started.first()).toBeVisible();
  await move('Filter Notifications to Agent looks stuck', async () => {
    await filter.tap();
    await screen.getByRole('button', 'Agent looks stuck').tap();
  });
  await expect(stuck.first()).toBeVisible();
  await expect(started).toHaveCount(0);
  await move('Show All categories in Notifications', async () => {
    await filter.tap();
    await screen.getByRole('button', 'All categories').tap();
  });
  await expect(started.first()).toBeVisible();
  const unread = screen.getByRole('button', /^Unread,/);
  await expect(unread.first()).toBeVisible({ timeout: 135_000 });
  await move('Mark all shown notifications read', async () => {
    await filter.tap();
    await screen.getByRole('button', 'Mark all read').tap();
  });
  await expect(unread).toHaveCount(0);
  await expect(started.first()).toBeVisible();
});
