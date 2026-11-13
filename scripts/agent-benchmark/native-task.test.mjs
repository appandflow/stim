import { expect, it } from 'vitest';
import { carriedOutputs } from './native-fixtures.mjs';
import {
  nativeInteractionSeconds,
  nativeProcessIdentityValid,
  nativeSourceProof,
  nativeTaskPrompt,
} from './native-task.mjs';

it('rejects an unchanged revision or unrelated source changes despite a matching screenshot marker', () => {
  const before = 'Text("native-revision-one")\n';
  const input = {
    before,
    after: 'Text("revision-run-one")\n',
    marker: 'revision-run-one',
    source: 'App.swift',
    changedPaths: ['App.swift'],
  };
  expect(nativeSourceProof(input)).toBe(true);
  expect(nativeSourceProof({ ...input, after: before })).toBe(false);
  expect(nativeSourceProof({ ...input, after: input.after + 'Text("Count: 1")\n' })).toBe(false);
  expect(nativeSourceProof({ ...input, changedPaths: ['App.swift', 'Package.swift'] })).toBe(false);
});

it('rejects missing or malformed process start identities before a native audit can pass', () => {
  expect(nativeProcessIdentityValid('macos', { pid: 42, startSeconds: '123', startMicros: 456 })).toBe(true);
  expect(nativeProcessIdentityValid('ios', { pid: 42 })).toBe(false);
  expect(nativeProcessIdentityValid('macos', { pid: 42, startSeconds: '123', startMicros: 1_000_000 })).toBe(false);
  expect(
    nativeProcessIdentityValid('android', {
      pid: 42,
      bootId: '01234567-89ab-cdef-0123-456789abcdef',
      startTicks: '123',
    }),
  ).toBe(true);
  expect(nativeProcessIdentityValid('android', { pid: 42, bootId: 'unknown', startTicks: '123' })).toBe(false);
});

it('asks for an exact crash repair without naming the cause, revision marker or source', () => {
  const input = {
    arm: 'control',
    platform: 'android',
    fixture: '/fixture',
    worktree: '/w',
    branch: 'b',
    marker: 'revision-secret',
    device: 'd',
    proofDirectory: '/p',
    session: 's',
    stateDirectory: '/s',
    variant: 'launch-crash',
  };
  const prompt = nativeTaskPrompt(input);
  expect(prompt).toContain('fails on launch');
  expect(prompt).toContain('preserve the surrounding source byte for byte');
  expect(prompt).not.toMatch(/revision-secret|MainActivity|onCreate|STIM_BENCH/);

  const exact = nativeTaskPrompt({ ...input, platform: 'ios', framework: 'exact' });
  expect(exact).toContain('its own fresh target directory');
  expect(exact).not.toContain('untimed native build outputs');
  expect(carriedOutputs('exact')).toEqual([]);
  expect(carriedOutputs('native-gradle')).toContain('mobile/build');
});

function interactionCommand(endedAt, output, exitCode = 0) {
  return {
    command: 'env AGENT_DEVICE_STATE_DIR=/tmp/bench AGENT_DEVICE_SESSION=test agent-device press @e4 --settle',
    endedAt,
    output,
    exitCode,
  };
}

it('measures the first successful interaction that displays Count: 1', () => {
  const run = { dispatchAt: '2026-11-13T15:00:00.000Z', runId: 'test', stateDirectory: '/tmp/bench' };
  const failed = interactionCommand('2026-11-13T15:00:10.000Z', 'Count: 1', 1);
  const click = interactionCommand('2026-11-13T15:00:12.300Z', '+ @e2 [text] "Count: 1"');
  const stale = interactionCommand('2026-11-13T14:59:59.000Z', 'Count: 1');
  const screenshot = {
    ...interactionCommand('2026-11-13T15:00:11.000Z', 'Count: 1'),
    command: 'agent-device screenshot /tmp/s.png',
  };
  const batched = { ...click, command: `/bin/zsh -lc '${click.command} && agent-device screenshot /tmp/s.png'` };
  const wrapped = { ...click, command: `/bin/zsh -lc '${click.command}'` };
  expect(nativeInteractionSeconds([failed, stale, screenshot, batched], run)).toBeNull();
  expect(nativeInteractionSeconds([failed, stale, screenshot, wrapped], run)).toBe(12.3);
  const snapshot = {
    ...interactionCommand('2026-11-13T15:00:13.000Z', '@e2 [text] "Count: 1"'),
    command: 'env AGENT_DEVICE_STATE_DIR=/tmp/bench AGENT_DEVICE_SESSION=test agent-device snapshot --force-full',
  };
  expect(nativeInteractionSeconds([snapshot], run)).toBeNull();
  const press = { ...click, output: 'Increment' };
  const wrongState = { ...snapshot, command: snapshot.command.replace('/tmp/bench', '/tmp/other') };
  const wrongSession = { ...snapshot, command: snapshot.command + ' --session other' };
  expect(nativeInteractionSeconds([press, wrongState, wrongSession], run)).toBeNull();
  const reopened = {
    ...press,
    command: press.command.replace('press @e4 --settle', 'open dev.example.app'),
  };
  expect(nativeInteractionSeconds([press, reopened, snapshot], run)).toBeNull();
  const removed = { ...click, output: '- @e2 [text] "Count: 1"\n+ @e2 [text] "Count: 2"' };
  expect(nativeInteractionSeconds([removed], run)).toBeNull();
  expect(nativeInteractionSeconds([press, snapshot], run)).toBe(13);
});
