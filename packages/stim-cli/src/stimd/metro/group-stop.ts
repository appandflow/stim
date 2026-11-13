import { processGroupAlive } from '@stim-cli/core/ownership-claim';
import { getExecutor } from '../../exec.ts';
import { signalProcessTree } from '../../metro.ts';
import { captureProcessToken, inspectProcessIdentity } from '../../process-identity.ts';

const POLL_MS = 50;

async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  return done();
}

/** The pids of process group `pgid`, zombies included, or null when `ps` cannot list them. */
function groupMembers(pgid: number): number[] | null {
  const listing = getExecutor().runFileQuiet('ps', ['-axo', 'pid=,pgid='], { timeoutMs: 10_000 });
  if (listing === null) return null;
  return listing.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    return row && Number(row[2]) === pgid ? [Number(row[1])] : [];
  });
}

/**
 * Stops a dev server's process group, the leader and every member, and returns once the group is empty. While the leader
 * reads `same` it records each member's identity, then sends SIGTERM to the group; a leader that already exited needs no
 * signal. The group gets `termMs` to drain, since members often outlive the leader by a moment. Each member still there
 * is then killed by its own pid after its own identity reads `same` in the same synchronous step, never by a group signal
 * without a verified leader. A member whose identity cannot be read, a leader that reads `unknown` or `different`, or a
 * group that does not empty is a refusal that names the failed check and the pids left.
 *
 * A pgid is not reused while any member lives (Linux keeps the struct pid of a group in use; XNU's `nextpid` skips pids
 * of existing process groups), so a live group of a gone leader is the dev server's own. Not guaranteed: a member that
 * forked after the last listing and exits in the instant between its listing and its kill can have its pid reused.
 */
export async function stopProcessGroup(
  leader: { pid: number; processToken: string },
  { termMs, killMs = 1000 }: { termMs: number; killMs?: number },
): Promise<void> {
  const pgid = leader.pid;
  if (!processGroupAlive(pgid)) return;
  const refuse = (detail: string) => new Error(`Could not stop the dev-server process group ${pgid}: ${detail}.`);
  const recorded = new Map<number, string | null>();
  const status = inspectProcessIdentity(leader);
  if (status === 'same') {
    for (const pid of groupMembers(pgid) ?? []) recorded.set(pid, captureProcessToken(pid));
    if (inspectProcessIdentity(leader) === 'same') {
      try {
        signalProcessTree(pgid, 'SIGTERM', { group: true });
      } catch {}
    }
  } else if (status !== 'gone') {
    throw refuse(`the leader's identity reads ${status}, so no signal was sent`);
  }
  if (await waitUntil(() => !processGroupAlive(pgid), termMs)) return;
  for (let round = 0; round < 3; round++) {
    const members = groupMembers(pgid);
    if (members === null) throw refuse('the group members could not be listed');
    const unreadable: number[] = [];
    for (const pid of members) {
      if (pid === process.pid || pid <= 1) continue;
      const processToken = recorded.get(pid) ?? captureProcessToken(pid);
      if (processToken === null) {
        unreadable.push(pid);
        continue;
      }
      const identity = inspectProcessIdentity({ pid, processToken });
      if (identity === 'unknown') unreadable.push(pid);
      else if (identity === 'same') {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
    if (unreadable.length > 0) throw refuse(`the identity of member pids ${unreadable.join(', ')} cannot be read`);
    if (await waitUntil(() => !processGroupAlive(pgid), killMs)) return;
  }
  throw refuse(`member pids ${(groupMembers(pgid) ?? []).join(', ') || 'unknown'} still run after SIGKILL`);
}
