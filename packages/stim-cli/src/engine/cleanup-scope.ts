export interface CleanupScope {
  /** Returns a function that drops the cleanup without running it. */
  defer(cleanup: () => void): () => void;
  /** Hands every pending cleanup to the returned function and leaves this scope empty. */
  transfer(): () => void;
  /** Runs pending cleanups, newest first; one that throws is reported and kept for the next call. */
  release(): void;
}

function drain(pending: (() => void)[], report: (error: unknown) => void): (() => void)[] {
  const kept: (() => void)[] = [];
  for (const cleanup of pending.toReversed()) {
    try {
      cleanup();
    } catch (error) {
      kept.unshift(cleanup);
      report(error);
    }
  }
  return kept;
}

export function createCleanupScope(report: (error: unknown) => void): CleanupScope {
  let pending: (() => void)[] = [];
  return {
    defer: (cleanup) => {
      pending.push(cleanup);
      return () => {
        pending = pending.filter((entry) => entry !== cleanup);
      };
    },
    transfer: () => {
      let handed = pending;
      pending = [];
      return () => {
        handed = drain(handed, report);
      };
    },
    release: () => {
      pending = drain(pending, report);
    },
  };
}
