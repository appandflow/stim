import { connect, type Socket } from 'node:net';
import { daemonNdjsonFile, stimdSocket, type DaemonStatus } from '@stim-cli/core/state';
import { formatLongDuration } from '../command-output.ts';
import type { Finding } from '../diagnostics/doctor.ts';
import { pathMissing } from '../stimd/run-dir.ts';
import { stimdBuildId } from './client.ts';
import { unansweredText } from './status.ts';

const ANSWER_WAIT_MS = 3000;
const RETRY_MS = 100;

/** Whether this home's stimd sends any reply within the wait, connecting again while the socket refuses or is missing. */
function answers(): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    let socket: Socket | undefined;
    let retry: NodeJS.Timeout | undefined;
    const finish = (answered: boolean) => {
      finished = true;
      clearTimeout(limit);
      clearTimeout(retry);
      socket?.destroy();
      resolve(answered);
    };
    const limit = setTimeout(() => finish(false), ANSWER_WAIT_MS);
    const attempt = () => {
      const current = connect(stimdSocket());
      socket = current;
      current.on('error', () => {});
      current.once('connect', () => current.write(`${JSON.stringify({ kind: 'cli', build: stimdBuildId() })}\n`));
      current.once('data', () => finish(true));
      current.once('close', () => {
        if (!finished) retry = setTimeout(attempt, RETRY_MS);
      });
    };
    attempt();
  });
}

/**
 * `{unanswered}` when `status` has a running stimd that sends no reply to a hello within 3 s, else `{}`. It only
 * observes: it starts no stimd and writes no claim.
 */
export async function probeDaemonAnswer(status: DaemonStatus): Promise<Pick<DaemonStatus, 'unanswered'>> {
  if (!status.running || (await answers())) return {};
  return {
    unanswered: {
      pid: status.running.pid,
      waitedMs: ANSWER_WAIT_MS,
      ...(process.platform !== 'win32' && pathMissing(stimdSocket()) ? { socketMissing: true as const } : {}),
    },
  };
}

/** The finding for a stimd that holds the claim and did not answer a hello. */
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
