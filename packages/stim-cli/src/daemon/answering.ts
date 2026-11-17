import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { daemonClaimRoot, daemonNdjsonFile, stimdSocket, type DaemonStatus } from '@stim-cli/core/state';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { formatLongDuration } from '../command-output.ts';
import type { Finding } from '../diagnostics/doctor.ts';
import { unansweredText } from './status.ts';

const ANSWER_WAIT_MS = 3000;
const RETRY_MS = 100;

/** What a stimd that answers the probe frame sends: its pid in this build, nothing in a stimd that predates it. */
interface Answer {
  pid?: number;
}

/**
 * This home's stimd's reply to a probe frame, connecting again while the socket refuses or is missing, or null when
 * none comes within the wait. stimd answers kind `probe` with its pid and build and closes, without counting the
 * connection as a client; a stimd that predates it answers with its unknown-kind error, which is a reply too.
 */
function ask(): Promise<Answer | null> {
  return new Promise((resolve) => {
    let finished = false;
    let socket: Socket | undefined;
    let retry: NodeJS.Timeout | undefined;
    const finish = (answer: Answer | null) => {
      finished = true;
      clearTimeout(limit);
      clearTimeout(retry);
      socket?.destroy();
      resolve(answer);
    };
    const limit = setTimeout(() => finish(null), ANSWER_WAIT_MS);
    const attempt = () => {
      const current = connect(stimdSocket());
      socket = current;
      let buffer = '';
      current.setEncoding('utf8');
      current.on('error', () => {});
      current.once('connect', () => current.write(`${JSON.stringify({ kind: 'probe' })}\n`));
      current.on('data', (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        let pid: unknown;
        try {
          pid = JSON.parse(buffer.slice(0, end)).pid;
        } catch {}
        finish(typeof pid === 'number' ? { pid } : {});
      });
      current.once('close', () => {
        if (!finished) retry = setTimeout(attempt, RETRY_MS);
      });
    };
    attempt();
  });
}

/** Whether the daemon claim still has the holder `running` names, so a probe is never reported against another one. */
function holds({ pid, since }: NonNullable<DaemonStatus['running']>): boolean {
  try {
    return readClaimSet(daemonClaimRoot()).live.some(
      (holder) => holder.owner.pid === pid && holder.startedAt === since,
    );
  } catch {
    return false;
  }
}

/**
 * `{unanswered}` when `status` has a running stimd that sends no reply within 3 s, else `{}`. A reply from another
 * pid than the claim's, or a claim holder that changed during the wait, is `{}`: the result belongs to the stimd it
 * was taken against. It only observes: it starts no stimd, writes no claim and is no client of stimd.
 */
export async function probeDaemonAnswer(status: DaemonStatus): Promise<Pick<DaemonStatus, 'unanswered'>> {
  const { running } = status;
  if (!running || (await ask()) || !holds(running)) return {};
  return {
    unanswered: {
      pid: running.pid,
      waitedMs: ANSWER_WAIT_MS,
      ...(process.platform !== 'win32' && !existsSync(stimdSocket()) ? { socketMissing: true as const } : {}),
    },
  };
}

/** `status` with the probe result, left out when it was taken against another stimd than the one `status` names. */
export function withAnswer(status: DaemonStatus, answer: Pick<DaemonStatus, 'unanswered'> = {}): DaemonStatus {
  return answer.unanswered && answer.unanswered.pid === status.running?.pid ? { ...status, ...answer } : status;
}

/** The finding for a stimd that holds the claim and did not answer the probe. */
export function unansweredFindings(status: DaemonStatus, now: number = Date.now()): Finding[] {
  const { unanswered, running } = status;
  if (!unanswered || !running) return [];
  const tickAt = Date.parse(status.lastTickAt ?? '');
  const tick = Number.isFinite(tickAt) ? `${formatLongDuration(Math.max(0, now - tickAt))} ago` : 'never written';
  return [
    {
      code: 'stimd-not-answering',
      level: 'cost',
      title: 'stimd holds its claim but did not answer',
      detail: `stimd pid ${unanswered.pid} ${unansweredText(unanswered)}; its last tick was ${tick}. This is what one probe saw: a busy machine can delay an answer. Commands that need stimd wait for it and then fail with STIM_DAEMON_UNAVAILABLE.`,
      fix: `Run \`stim status\` again to see whether it answers now; ${daemonNdjsonFile()} has what it last did.`,
    },
  ];
}
