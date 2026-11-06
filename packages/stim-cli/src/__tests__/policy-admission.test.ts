import * as fc from 'fast-check';
import { busySlots, displacedLeases, leaseGrant, leaseRaise, slotTurn } from '../policy/admission.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

const slot = fc.record({
  index: fc.option(fc.integer({ min: 0, max: 9 })),
  alive: fc.boolean(),
  unresolved: fc.boolean(),
});

describe('build slot admission', () => {
  test('the waiters that may claim are the front of the queue and never outnumber the slots no live build holds', () => {
    fc.assert(
      fc.property(
        fc.array(slot, { maxLength: 10 }),
        fc.integer({ min: 1, max: 8 }),
        fc.nat(12),
        (slots, max, waiting) => {
          const busy = busySlots(slots, max);
          const live = slots.filter(({ index, alive }) => alive && index !== null && index < max).length;
          const claims = Array.from({ length: waiting + 1 }, (_, i) => slotTurn(i + 1, max, busy).claim);
          const allowed = claims.filter(Boolean).length;
          expect(claims.slice(0, allowed).every(Boolean)).toBe(true);
          expect(allowed + live).toBeLessThanOrEqual(Math.max(max, live));
        },
      ),
    );
  });

  test('a build that polls first is admitted only while every older waiting build still has a slot', () => {
    const event = fc.oneof(
      fc.constant('arrive' as const),
      fc.constant('release' as const),
      fc.array(fc.nat(), { minLength: 8, maxLength: 8 }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.array(event, { maxLength: 40 }), (max, events) => {
        const held = new Set<number>();
        const queue: number[] = [];
        const stranded: number[] = [];
        let arrivals = 0;
        let peak = 0;
        const slots = () => [...held].map((index) => ({ index, alive: true, unresolved: false }));
        for (const step of events) {
          if (step === 'arrive') queue.push(arrivals++);
          else if (step === 'release') held.delete([...held][0] ?? -1);
          else {
            const order = queue.toSorted((a, b) => (step[a % 8] ?? 0) - (step[b % 8] ?? 0));
            for (const build of order) {
              if (!slotTurn(queue.indexOf(build) + 1, max, busySlots(slots(), max)).claim) continue;
              held.add(Array.from({ length: max }, (_, index) => index).find((index) => !held.has(index)) ?? max);
              const older = queue.slice(0, queue.indexOf(build));
              queue.splice(queue.indexOf(build), 1);
              const busy = busySlots(slots(), max);
              stranded.push(...older.filter((_, i) => !slotTurn(i + 1, max, busy).claim));
            }
          }
          peak = Math.max(peak, held.size);
        }
        expect(stranded).toEqual([]);
        expect(peak).toBeLessThanOrEqual(max);
      }),
    );
  });
});

const ROOTS = ['/a', '/b'];
const SLOTS = ['default', 'second'];
const lease = (expiresInMs: fc.Arbitrary<number>) =>
  fc.record({
    holder: fc.constantFrom(...ROOTS),
    slot: fc.constantFrom(undefined, 'second'),
    token: fc.constantFrom('t1', 't2'),
    expiresAt: expiresInMs.map(at),
  });
const request = fc.record({
  root: fc.constantFrom(...ROOTS),
  slot: fc.constantFrom(...SLOTS),
  kind: fc.constantFrom('declared' as const, 'run' as const),
  declared: fc.boolean(),
  durationMs: fc.integer({ min: 10_000, max: 1_800_000 }),
});

describe('device lease admission', () => {
  test('a live lease is never granted to another workspace or slot, and a run never shortens a declared one', () => {
    fc.assert(
      fc.property(lease(fc.integer({ min: 1, max: 3_600_000 })), request, (current, asked) => {
        const grant = leaseGrant({ lease: current, now: NOW, ...asked });
        const mine = current.holder === asked.root && (current.slot ?? 'default') === asked.slot;
        const asksFor = NOW + asked.durationMs;
        const runOnDeclared = asked.declared && asked.kind === 'run';
        expect(grant).toEqual(
          mine
            ? {
                status: 'set',
                lease: current,
                expiresAt: runOnDeclared ? Math.max(Date.parse(current.expiresAt), asksFor) : asksFor,
                kind: asked.declared ? 'declared' : asked.kind,
              }
            : { status: 'held', lease: current },
        );
      }),
    );
  });

  test('a missing or expired lease is taken by any workspace for the asked duration and kind', () => {
    fc.assert(
      fc.property(fc.option(lease(fc.integer({ min: -3_600_000, max: 0 }))), request, (current, asked) => {
        expect(leaseGrant({ lease: current, now: NOW, ...asked })).toEqual({
          status: 'taken',
          expiresAt: NOW + asked.durationMs,
          kind: asked.kind,
        });
      }),
    );
  });

  test('a lease file that is not a lease is never granted', () => {
    fc.assert(
      fc.property(request, (asked) => {
        expect(leaseGrant({ lease: 'unreadable', now: NOW, ...asked })).toEqual({ status: 'unreadable' });
      }),
    );
  });

  test('taking a device releases only the leases the same workspace holds for that platform and slot elsewhere', () => {
    const entry = fc.option(
      fc.record({
        holder: fc.constantFrom(...ROOTS),
        slot: fc.constantFrom(undefined, 'second'),
        token: fc.constant('t'),
        expiresAt: fc.constant(at(60_000)),
        platform: fc.constantFrom('ios', 'android'),
        id: fc.constantFrom('D1', 'D2', 'D3'),
      }),
    );
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 8 }), fc.constantFrom(...SLOTS), (entries, slotName) => {
        const taking = { root: '/a', platform: 'ios', slot: slotName, id: 'D1' };
        const released = displacedLeases(entries, taking);
        const elsewhere = entries.filter(
          (other) =>
            other?.holder === '/a' &&
            other.platform === 'ios' &&
            (other.slot ?? 'default') === slotName &&
            other.id !== 'D1',
        );
        expect(released).toEqual(elsewhere);
      }),
    );
  });

  test('a run keeps its lease at least the asked time without ever shortening it, and loses it once its token is gone', () => {
    fc.assert(
      fc.property(
        fc.option(lease(fc.integer({ min: -600_000, max: 3_600_000 }))),
        fc.integer({ min: 1_000, max: 1_800_000 }),
        (current, minMs) => {
          const raise = leaseRaise(current, 't1', NOW, minMs);
          const ends = current ? Date.parse(current.expiresAt) : 0;
          expect(raise).toEqual(
            current?.token !== 't1'
              ? { status: 'lost' }
              : ends >= NOW + minMs
                ? { status: 'kept', lease: current }
                : { status: 'raised', lease: current, expiresAt: NOW + minMs },
          );
        },
      ),
    );
  });
});
