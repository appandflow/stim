import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseClaude } from '../drivers/claude.ts';
import { parseCodex } from '../drivers/codex.ts';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('a recorded Claude run reports the isolation the agent saw, its Skill call and the denied Bash attempts', () => {
  const run = parseClaude(fixture('claude-denied.jsonl'));
  expect(run.isolation).toEqual({ skills: ['stim', 'design', 'doctor'], mcpServers: [], plugins: [] });
  expect(run.skills).toEqual(['stim']);
  expect(run.commands).toEqual([
    { command: 'npx stim guide agent', denied: true },
    { command: 'npx stim guide agent', denied: true },
  ]);
  expect(run.turns).toBe(5);
  expect(run.costUsd).toBeCloseTo(0.0146092);
  expect(run.tokens.input + run.tokens.output).toBe(44666);
  expect(run.error).toBeNull();
});

test('a recorded Claude run that finished reports its shell commands in order and the cache-inclusive input tokens', () => {
  const run = parseClaude(fixture('claude-first-launch.jsonl'));
  expect(run.commands.map((each) => each.command)).toEqual([
    'stim guide agent',
    'ls -la',
    'stim guide agent react-native',
    'stim start',
    'stim ios',
  ]);
  expect(run.commands.some((each) => each.denied)).toBe(false);
  expect(run.tokens).toEqual({ input: 76 + 7834 + 114485, output: 1811, cached: 114485 });
  expect(run.turns).toBe(10);
});

test('a Claude transcript cut off before its result is an error, not a zero-turn pass', () => {
  const cut = fixture('claude-denied.jsonl').split('\n').slice(0, 3).join('\n');
  expect(parseClaude(cut).error).toMatch(/no result event/);
});

test('a recorded Codex run unwraps the shell, finds the skill read and sums usage', () => {
  const run = parseCodex(fixture('codex-first-launch.jsonl'));
  expect(run.commands.map((each) => each.command)).toContain('stim worktree warm');
  expect(run.skills).toEqual(['stim']);
  expect(run.tokens).toEqual({ input: 143191, output: 468, cached: 103296 });
  expect(run.turns).toBe(13);
  expect(run.finalMessage).toMatch(/^Launched/);
  expect(run.error).toBeNull();
});

test('a Codex transcript without turn.completed is an error', () => {
  const cut = fixture('codex-first-launch.jsonl').split('\n').slice(0, 6).join('\n');
  expect(parseCodex(cut).error).toMatch(/no turn.completed/);
});
