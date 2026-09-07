import { describe, expect, it } from 'vitest';
import { reconstructCommandEvidence } from './command-evidence.mjs';
import { benchmarkSetupInvalidReasons } from './run-guards.mjs';

const stamp = (second, event) => ({
  arrivedAt: new Date(Date.UTC(2026, 8, 7, 12, 0, second)).toISOString(),
  line: JSON.stringify(event),
});
const codex = (second, id, command, done = false) =>
  stamp(second, {
    type: done ? 'item.completed' : 'item.started',
    item: { id, type: 'command_execution', command, ...(done ? { exit_code: 0, aggregated_output: 'done' } : {}) },
  });
const bash = (second, id, command, background = false) =>
  stamp(second, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command, run_in_background: background } }] },
  });
const result = (second, id, data, content = 'output') =>
  stamp(second, {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
    tool_use_result: data,
  });
const query = (second, id, taskId) =>
  stamp(second, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'TaskOutput', id, input: { task_id: taskId, block: true } }] },
  });
const setup = (runner, events) =>
  benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'ios' }, reconstructCommandEvidence(runner, events).commands);

describe('command completion evidence', () => {
  it('retains unfinished Codex warm jobs so an earlier completed warm cannot hide overlap', () => {
    const events = [
      codex(0, 'guide', 'stim guide agent'),
      codex(1, 'guide', 'stim guide agent', true),
      codex(2, 'warm', 'stim worktree warm'),
      codex(3, 'warm', 'stim worktree warm', true),
      codex(4, 'warm-again', 'stim worktree warm'),
      codex(5, 'start', 'stim start'),
      codex(6, 'start', 'stim start', true),
    ];
    const evidence = reconstructCommandEvidence('codex', events);
    expect(evidence.commands.find((command) => command.id === 'warm-again')).toMatchObject({
      exitCode: null,
      endedAt: null,
      startEventOffset: 4,
      endEventOffset: null,
    });
    expect(evidence.completedEvents.map((event) => event.id)).toEqual(['guide', 'warm', 'start']);
    expect(setup('codex', events)).toEqual(['stim-worktree-warm-not-complete-before-use']);
  });

  it.each([{}, { backgroundTaskId: 'warm-task' }])(
    'does not infer completion for submitted Claude jobs: %j',
    (data) => {
      const events = [bash(0, 'warm', 'stim worktree warm', true), result(1, 'warm', data)];
      const evidence = reconstructCommandEvidence('claude', events);
      expect(evidence.commands[0]).toMatchObject({ command: 'stim worktree warm', exitCode: null, endedAt: null });
      expect(evidence.completedEvents).toEqual([]);
      expect(setup('claude', events)).toContain('stim-worktree-warm-missing-or-failed');
    },
  );

  it('correlates Claude task completion to its original command, not the submission or polling start', () => {
    const events = [
      bash(0, 'guide', 'stim guide agent'),
      result(1, 'guide', { stdout: 'guide', stderr: '', interrupted: false }),
      bash(2, 'warm', 'stim worktree warm'),
      result(3, 'warm', { backgroundTaskId: 'warm-task' }),
      query(4, 'poll', 'warm-task'),
      result(5, 'poll', {
        retrieval_status: 'success',
        task: {
          task_id: 'warm-task',
          task_type: 'local_bash',
          status: 'completed',
          exitCode: 0,
          output: 'carry complete',
        },
      }),
      bash(6, 'start', 'stim start'),
      result(7, 'start', { stdout: 'started', stderr: '', interrupted: false }),
    ];
    const evidence = reconstructCommandEvidence('claude', events);
    expect(evidence.commands.find((command) => command.id === 'warm')).toMatchObject({
      startedAt: stamp(2, {}).arrivedAt,
      endedAt: stamp(5, {}).arrivedAt,
      exitCode: 0,
      elapsedSeconds: 3,
      startEventOffset: 2,
      endEventOffset: 5,
      output: 'carry complete',
    });
    expect(evidence.activities).toEqual([]);
    expect(setup('claude', events)).toEqual([]);
    const overlapping = [...events.slice(0, 4), events[6], events[7], events[4], events[5]];
    expect(setup('claude', overlapping)).toEqual(['stim-worktree-warm-not-complete-before-use']);
  });

  it.each([
    { retrieval_status: 'timeout', task: { task_id: 'warm-task', status: 'running', exitCode: null } },
    { retrieval_status: 'success', task: { task_id: 'another-task', status: 'completed', exitCode: 0 } },
    { retrieval_status: 'success', task: { task_id: 'warm-task', status: 'running', exitCode: 0 } },
    { retrieval_status: 'success', task: { task_id: 'warm-task', status: 'completed' } },
  ])('keeps unproven task results pending: %j', (data) => {
    const events = [
      bash(0, 'warm', 'stim worktree warm'),
      result(1, 'warm', { backgroundTaskId: 'warm-task' }),
      query(2, 'poll', 'warm-task'),
      result(3, 'poll', { ...data, task: { task_type: 'local_bash', ...data.task } }),
    ];
    expect(reconstructCommandEvidence('claude', events).commands[0].exitCode).toBeNull();
  });

  it('keeps interrupted foreground commands and failed tasks from proving successful warm', () => {
    expect(
      reconstructCommandEvidence('claude', [
        bash(0, 'warm', 'stim worktree warm'),
        result(1, 'warm', { interrupted: true }),
      ]).commands[0].exitCode,
    ).toBe(1);
    expect(
      reconstructCommandEvidence('claude', [
        bash(0, 'warm', 'stim worktree warm'),
        result(1, 'warm', { backgroundTaskId: 'warm-task' }),
        query(2, 'poll', 'warm-task'),
        result(3, 'poll', {
          retrieval_status: 'success',
          task: { task_id: 'warm-task', task_type: 'local_bash', status: 'failed', exitCode: 1 },
        }),
      ]).commands[0].exitCode,
    ).toBe(1);
  });
});
