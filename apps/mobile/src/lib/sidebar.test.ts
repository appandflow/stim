import { homeIsVisible, sidebarOf } from './sidebar';

const division = (x: number, width: number, height = 951) => [
  { kind: 'division' as const, frame: { x, y: 0, width, height }, occludesContent: true },
];

it('keeps the drawer on a cover and uses a compact sidebar on a wide flat window', () => {
  expect(sidebarOf([], 466, 678)).toBeNull();
  expect(sidebarOf([], 639, 951)).toBeNull();
  expect(sidebarOf([], 640, 951)).toEqual({ width: 640 / 3, gap: 0 });
  expect(sidebarOf([], 669, 951)).toEqual({ width: 669 / 3, gap: 0 });
  expect(sidebarOf([], 844, 390)).toBeNull();
});

it('aligns the panes with a book fold even below the flat-window threshold', () => {
  expect(sidebarOf(division(330, 9), 669, 951)).toEqual({ width: 330, gap: 9 });
  expect(sidebarOf(division(471, 9, 669), 951, 669)).toEqual({ width: 471, gap: 9 });
});

it('collapses when either physical panel is too narrow', () => {
  expect(sidebarOf(division(290, 9), 669, 951)).toBeNull();
  expect(sidebarOf(division(380, 9), 669, 951)).toBeNull();
});

it('returns to the flat layout when the division disappears after unfolding', () => {
  expect(sidebarOf(division(471, 9, 669), 951, 669)?.width).toBe(471);
  expect(sidebarOf([], 951, 669)).toEqual({ width: 317, gap: 0 });
});

it('keeps the actual home background visible through form sheets without inventing it under details', () => {
  const home = { name: 'index' };
  const filters = { name: 'filters', presentation: 'formSheet' };
  const machine = { name: 'mac/[id]/index', presentation: 'formSheet' };
  const workspace = { name: 'mac/[id]/workspace' };
  const build = { name: 'mac/[id]/build', presentation: 'formSheet' };
  expect(homeIsVisible([home, filters])).toBe(true);
  expect(homeIsVisible([home, machine])).toBe(true);
  expect(homeIsVisible([home, machine, build])).toBe(true);
  expect(homeIsVisible([home, workspace, build])).toBe(false);
  expect(homeIsVisible([home, { name: 'pair', presentation: 'modal' }, machine])).toBe(false);
  expect(homeIsVisible([machine])).toBe(false);
});
