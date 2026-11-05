import { sidebarOf } from './sidebar';

it('keeps the menu and content on opposite sides of a book-fold division', () => {
  const sidebar = sidebarOf(
    [{ kind: 'division', frame: { x: 330, y: 0, width: 9, height: 951 }, occludesContent: true }],
    669,
    951,
  );
  expect(sidebar).not.toBeNull();
  expect(sidebar!.width).toBeLessThanOrEqual(330);
  expect(sidebar!.width + sidebar!.gap).toBeGreaterThanOrEqual(339);
  expect(sidebar!.width + sidebar!.gap).toBeLessThan(669);
});
