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

export interface GroupMember {
  pid: number;
  /** `ps` reports state Z: the process exited and waits for its parent to reap it. */
  zombie: boolean;
}

/** The members of process group `pgid` in a `ps -axo pid=,pgid=,stat=` listing, from procps and BSD `ps` alike. */
export function parseGroupListing(listing: string, pgid: number): GroupMember[] {
  return listing.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    return row && Number(row[2]) === pgid ? [{ pid: Number(row[1]), zombie: row[3]?.startsWith('Z') === true }] : [];
  });
}

/** The members of process group `pgid`, zombies marked, or null when `ps` cannot list them. */
function groupMembers(pgid: number): GroupMember[] | null {
  const listing = getExecutor().runFileQuiet('ps', ['-axo', 'pid=,pgid=,stat='], { timeoutMs: 10_000 });
  return listing === null ? null : parseGroupListing(listing, pgid);
}

const pidList = (members: GroupMember[] | null) =>
  members === null
    ? 'unknown'
    : members
        .map((member) => (member.zombie ? `${member.pid} (a zombie, waiting for its parent to reap it)` : member.pid))
        .join(', ') || 'unknown';

/**
 * Stops a dev server's process group, the leader and every member, and returns once the group is empty. While the leader
 * reads `same` it records each running member's identity, then sends SIGTERM to the group; a leader that already exited
 * needs no signal. The group gets `termMs` to drain, since members often outlive the leader by a moment. Each member
 * still running is then killed by its own pid, never by a group signal without a verified leader: a recorded member only
 * while its recorded identity reads `same`, and a member recorded as unreadable or forked later by its group membership,
 * read from one listing taken in the same synchronous step as the kills of that round. A zombie is not a running process:
 * it is never signalled, and the group counts as empty only once it is reaped, so a group left with zombies alone is a
 * refusal that says so. A member whose recorded identity reads `unknown` is not signalled and does not refuse by itself;
 * only a group that is still not empty after the kill rounds and the final wait does, naming the pids that remain, the
 * zombies among them and the ones whose identity could not be read. A leader reading `unknown` or `different`, or a
 * leader that exited before its members were recorded while members remain, is a refusal too.
 *
 * A pgid is not reused while any member lives (Linux `kernel/pid.c`: `__change_pid` keeps the struct pid while a task
 * uses it as a PGID, and `idr_alloc_cyclic` allocates pids cyclically; XNU `bsd/kern/kern_fork.c` pid allocation skips
 * pids of existing process groups), so a live group of a gone leader is the dev server's own. Not guaranteed: a pid
 * reused between the listing and the kill of the same round, which cyclic allocation makes impractical.
 */
export async function stopProcessGroup(
  leader: { pid: number; processToken: string },
  {
    termMs,
    killMs = 1000,
    groupAlive = processGroupAlive,
    signalGroup = (pgid) => {
      signalProcessTree(pgid, 'SIGTERM', { group: true });
    },
    killMember = (pid) => {
      signalProcessTree(pid, 'SIGKILL');
    },
  }: {
    termMs: number;
    killMs?: number;
    groupAlive?: (pgid: number) => boolean;
    signalGroup?: (pgid: number) => void;
    killMember?: (pid: number) => void;
  },
): Promise<void> {
  const pgid = leader.pid;
  if (!groupAlive(pgid)) return;
  const refuse = (detail: string) => new Error(`Could not stop the dev-server process group ${pgid}: ${detail}.`);
  const recorded = new Map<number, string | null>();
  const status = inspectProcessIdentity(leader);
  if (status === 'same') {
    for (const member of groupMembers(pgid) ?? [])
      if (!member.zombie) recorded.set(member.pid, captureProcessToken(member.pid));
    if (inspectProcessIdentity(leader) === 'same') {
      try {
        signalGroup(pgid);
      } catch {}
    }
  } else if (status !== 'gone') {
    throw refuse(`the leader's identity reads ${status}, so no signal was sent`);
  }
  if (await waitUntil(() => !groupAlive(pgid), termMs)) return;
  if (status !== 'same')
    throw refuse(
      `the leader had already exited and its members were not recorded while it ran, so no signal was sent; member pids ${pidList(groupMembers(pgid))} still run`,
    );
  const unreadable = new Set<number>();
  for (let round = 0; round < 3; round++) {
    const members = groupMembers(pgid);
    if (members === null) throw refuse('the group members could not be listed');
    for (const { pid, zombie } of members) {
      if (zombie || pid === process.pid || pid <= 1) continue;
      const processToken = recorded.get(pid) ?? null;
      if (processToken !== null) {
        const identity = inspectProcessIdentity({ pid, processToken });
        if (identity === 'unknown') unreadable.add(pid);
        if (identity !== 'same') continue;
      }
      try {
        killMember(pid);
      } catch {}
    }
    if (await waitUntil(() => !groupAlive(pgid), killMs)) return;
  }
  const left = groupMembers(pgid);
  const unread = [...unreadable].filter((pid) => left?.some((member) => member.pid === pid));
  throw refuse(
    `member pids ${pidList(left)} still ${left?.every((member) => member.zombie) ? 'exist' : 'run'} after SIGKILL${unread.length > 0 ? `; the identity of pids ${unread.join(', ')} could not be read, so they were not signalled` : ''}`,
  );
}
