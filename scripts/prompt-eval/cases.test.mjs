import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { cases, commandState, websitePrompt } from './cases.mjs';

const workspace = '/fixture/app';
function driver(id) {
  const state = commandState(id, workspace);
  const run = (args, cwd = workspace, file = 'stim') => state.accept({ file, args, cwd });
  return { state, run };
}

describe('website prompt command selection', () => {
  it('reads each actual website prompt without relying on a copied prompt corpus', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    for (const entry of cases) expect(websitePrompt(root, entry).length).toBeGreaterThan(10);
  });

  it('rejects an action before the version-matched root guide and a wrong workspace', () => {
    const { run } = driver('logs');
    expect(() => run(['logs', '--errors', '--since', '10m'])).toThrow('guide agent');
    run(['guide', 'agent']);
    expect(() => run(['logs', '--errors', '--since', '10m'], '/elsewhere')).toThrow('Wrong workspace');
    expect(run(['logs', '--since', '10m', '--errors', '--json'])).toEqual({ done: true });
  });

  it('catches a seeded wrong command, missing error filter, and wrong time window', () => {
    const { run } = driver('logs');
    run(['guide', 'agent']);
    expect(() => run(['status'])).toThrow('Unexpected Stim action');
    expect(() => run(['logs', '--since', '10m'])).toThrow('Expected errors');
    expect(() => run(['logs', '--errors', '--since', '1m'])).toThrow('Expected errors');
  });

  it('requires start before the selected simulator and rejects a hardware mixup', () => {
    const { run } = driver('simulator');
    run(['guide', 'agent']);
    const target = ['ios', '--device-type', 'iPhone 17', '--runtime', '26.5'];
    expect(() => run(target)).toThrow('follow start');
    run(['start']);
    expect(() => run([...target, '--device'])).toThrow('Wrong simulator');
    expect(() => run(['ios'])).toThrow('Wrong simulator');
    expect(run(target)).toEqual({ done: true });
  });

  it('does not count simulator launch as the connected phone', () => {
    const { run } = driver('phone');
    run(['guide', 'agent']);
    run(['start']);
    expect(() => run(['ios'])).toThrow('Expected physical');
    expect(run(['ios', '--device'])).toEqual({ done: true });
  });

  it('requires all three distinct slot targets before completing', () => {
    const { run } = driver('slots');
    run(['guide', 'agent']);
    run(['start']);
    expect(() => run(['ios', '--slot', 'tablet'])).toThrow('requires an iPad');
    expect(() => run(['ios', '--slot', 'tablet', '--device-type', 'iPad imaginary'])).toThrow('requires an iPad');
    expect(() => run(['ios', '--slot', 'hardware'])).toThrow('physical-device slot');
    expect(run(['ios', '--slot', 'phone']).done).toBeUndefined();
    expect(JSON.parse(run(['--help'], workspace, 'agent-device').output).exitCode).toBe(127);
    expect(() => run(['ios', '--slot', 'phone'])).toThrow('repeated');
    expect(run(['ios', '--slot', 'tablet', '--device-type', 'iPad Pro 13-inch (M5)']).done).toBeUndefined();
    expect(run(['ios', '--slot', 'hardware', '--device'])).toEqual({ done: true });
  });

  it('requires warming the newly created worktree instead of the original checkout', () => {
    const { run } = driver('warm');
    run(['guide', 'agent']);
    expect(run(['log', '-1', '--oneline', '--decorate'], workspace, 'git').output).toContain('update the example UI');
    expect(() => run(['worktree', 'warm'])).toThrow('new worktree');
    run(['worktree', 'add', '-b', 'feature', '../feature', 'HEAD'], workspace, 'git');
    expect(() => run(['worktree', 'warm'])).toThrow('new worktree');
    expect(run(['worktree', 'warm'], '/fixture/feature')).toEqual({ done: true });
  });

  it('refuses unsupported executables, shell syntax, duplicate flags, and guide injection', () => {
    const { run } = driver('logs');
    expect(() => run(['-c', 'stim logs'], workspace, 'sh')).toThrow('Unexpected command');
    expect(() => run(['guide', 'agent; xcrun simctl boot all'])).toThrow('Invalid guide');
    run(['guide', 'agent']);
    expect(() => run(['logs', '--errors', '--errors'])).toThrow('Duplicate flag');
    expect(() => run(['logs', '--errors', '--since'])).toThrow('Missing flag value');
  });
});
