import { PointerGrab } from '../src/pointer-grab.ts';

const ann = { id: 'v1', name: 'Ann' };
const bob = { id: 'v2', name: 'Bob' };
const touch = (phase: 'down' | 'move' | 'up', x = 0.5, y = 0.5) => ({ phase, x, y });

test('the first finger down holds the pointer; others are turned away and told who holds it', () => {
  const grab = new PointerGrab<typeof ann, ReturnType<typeof touch>>();
  expect(grab.admit(ann, touch('down'))).toEqual({ admit: true });
  expect(grab.admit(bob, touch('down'))).toEqual({ admit: false, busy: 'Ann' });
  expect(grab.admit(bob, touch('move'))).toEqual({ admit: false });
  expect(grab.admit(bob, touch('up'))).toEqual({ admit: false });
  expect(grab.admit(ann, touch('move'))).toEqual({ admit: true });
  expect(grab.holder).toBe(ann);
});

test('the holder lifting the pointer frees it for the next finger down', () => {
  const grab = new PointerGrab<typeof ann, ReturnType<typeof touch>>();
  grab.admit(ann, touch('down'));
  expect(grab.admit(ann, touch('up'))).toEqual({ admit: true });
  expect(grab.holder).toBeNull();
  expect(grab.admit(bob, touch('down'))).toEqual({ admit: true });
  expect(grab.admit(ann, touch('move'))).toEqual({ admit: false });
});

test('a move or up with no finger down is dropped', () => {
  const grab = new PointerGrab<typeof ann, ReturnType<typeof touch>>();
  expect(grab.admit(ann, touch('move'))).toEqual({ admit: false });
  expect(grab.admit(ann, touch('up'))).toEqual({ admit: false });
});

test('a holder that leaves or goes quiet is lifted at its last point, and its later touches are dropped', () => {
  const grab = new PointerGrab<typeof ann, ReturnType<typeof touch>>();
  grab.admit(ann, touch('down', 0.1, 0.2));
  grab.admit(ann, touch('move', 0.3, 0.4));
  expect(grab.release(bob.id)).toBeNull();
  expect(grab.release(ann.id)).toEqual({ holder: ann, up: touch('up', 0.3, 0.4) });
  expect(grab.admit(ann, touch('up'))).toEqual({ admit: false });

  grab.admit(bob, touch('down', 0.7, 0.8));
  expect(grab.expire()).toEqual({ holder: bob, up: touch('up', 0.7, 0.8) });
  expect(grab.expire()).toBeNull();
  expect(grab.admit(bob, touch('move'))).toEqual({ admit: false });
  expect(grab.admit(ann, touch('down'))).toEqual({ admit: true });
});
