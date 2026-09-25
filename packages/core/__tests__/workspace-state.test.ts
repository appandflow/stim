import { lastUseFrom } from '../state/workspace-state.ts';

describe('last use of a workspace', () => {
  const at = (iso: string) => Date.parse(iso);

  test('newer evidence than the recorded lastUsedAt wins, so a long Metro session is not idle', () => {
    expect(
      lastUseFrom({ lastUsedAt: '2026-09-01T00:00:00Z', lastBuild: { startedAt: '2026-09-20T00:00:00Z' } }, [
        at('2026-09-21T00:00:00Z'),
      ]),
    ).toBe(at('2026-09-21T00:00:00Z'));
    expect(lastUseFrom({ lastUsedAt: '2026-09-22T00:00:00Z' }, [at('2026-09-21T00:00:00Z')])).toBe(
      at('2026-09-22T00:00:00Z'),
    );
  });

  test('without lastUsedAt, the newest of the last build, the supervisor start and the log mtimes is used', () => {
    const state = {
      lastBuild: { startedAt: '2026-09-02T00:00:00Z' },
      supervisor: { startedAt: '2026-09-05T00:00:00Z' },
    };
    expect(lastUseFrom(state, [at('2026-09-03T00:00:00Z')])).toBe(at('2026-09-05T00:00:00Z'));
    expect(lastUseFrom(state, [at('2026-09-07T00:00:00Z')])).toBe(at('2026-09-07T00:00:00Z'));
  });

  test('a workspace with no evidence of use has no last use', () => {
    expect(lastUseFrom(null, [])).toBeNaN();
    expect(lastUseFrom({ lastUsedAt: 'garbage' }, [])).toBeNaN();
  });
});
