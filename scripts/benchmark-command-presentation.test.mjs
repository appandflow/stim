import { describe, expect, it } from 'vitest';
import { benchmarkCommandPresentation } from './benchmark-command-presentation.mjs';

describe('benchmark command presentation', () => {
  it('uses a captured successful exit marker without trusting the final echo exit code', () => {
    const command = 'cd ./worktrees/run && stim worktree warm; echo "EXIT=$?"';
    expect(
      benchmarkCommandPresentation(command, 0, 'carry complete\nEXIT=0\nShell cwd was reset to ./fixture'),
    ).toEqual({
      command: 'stim worktree warm',
      cwd: './worktrees/run',
    });
    expect(
      benchmarkCommandPresentation('cd ./run && build | tail -40; echo "PIPELINE_EXIT=$?"', 0, 'PIPELINE_EXIT=0'),
    ).toEqual({ command: 'build | tail -40', cwd: './run' });
    for (const output of ['', 'EXIT=1', 'EXIT=0\nEXIT=1', 'EXIT=0\nEXIT=0']) {
      expect(benchmarkCommandPresentation(command, 0, output)).toBeUndefined();
    }
    expect(benchmarkCommandPresentation(command, 1, 'EXIT=0')).toBeUndefined();
    expect(benchmarkCommandPresentation('cd missing && stim ios; echo "EXIT=0"', 0, 'EXIT=0')).toBeUndefined();
    expect(benchmarkCommandPresentation("cd missing && stim ios; echo 'EXIT=$?'", 0, 'EXIT=0')).toBeUndefined();
    expect(
      benchmarkCommandPresentation('cd missing && stim ios; echo done; echo "EXIT=$?"', 0, 'EXIT=0'),
    ).toBeUndefined();
  });

  it('moves a successful literal directory prefix into context without changing the command body', () => {
    expect(benchmarkCommandPresentation('cd "./worktrees/my app" && stim worktree warm', 0)).toEqual({
      command: 'stim worktree warm',
      cwd: './worktrees/my app',
    });
    expect(benchmarkCommandPresentation('cd -- ./worktrees/run && stim start && stim ios', 0)).toEqual({
      command: 'stim start && stim ios',
      cwd: './worktrees/run',
    });
    expect(benchmarkCommandPresentation('cd\v./worktrees/run && stim ios', 0)).toEqual({
      command: 'stim ios',
      cwd: './worktrees/run',
    });
  });

  it('removes only isolation assignments on actual agent-device invocations', () => {
    expect(
      benchmarkCommandPresentation(
        'cd ./worktrees/run && env AGENT_DEVICE_STATE_DIR="./state/tool state" AGENT_DEVICE_SESSION=run agent-device screenshot proof.png',
        0,
      ),
    ).toEqual({
      command: 'agent-device screenshot proof.png',
      cwd: './worktrees/run',
      isolatedAgentDevice: true,
    });
    expect(benchmarkCommandPresentation('env DEBUG=1 AGENT_DEVICE_SESSION=run agent-device snapshot', 0)).toEqual({
      command: 'env DEBUG=1 agent-device snapshot',
      isolatedAgentDevice: true,
    });
    expect(benchmarkCommandPresentation('AGENT_DEVICE_SESSION=run agent-device close', 0)).toEqual({
      command: 'agent-device close',
      isolatedAgentDevice: true,
    });
  });

  it('handles repeated invocations and literal loops without touching quoted command examples', () => {
    const command =
      'echo "env AGENT_DEVICE_SESSION=example agent-device close"; for i in 1 2; do env AGENT_DEVICE_SESSION=run agent-device snapshot; done\nenv AGENT_DEVICE_STATE_DIR=state agent-device close';
    expect(benchmarkCommandPresentation(command, 0)).toEqual({
      command:
        'echo "env AGENT_DEVICE_SESSION=example agent-device close"; for i in 1 2; do agent-device snapshot; done\nagent-device close',
      isolatedAgentDevice: true,
    });
  });

  it('keeps failed directory setup, dynamic paths, shell expansion and heredoc bodies visible', () => {
    const unchanged = [
      ['cd missing && stim ios', 1],
      ['cd ./run && stim ios', null],
      ['cd ./run; stim ios', 0],
      ['cd missing && stim ios; echo done', 0],
      ['cd missing && stim ios || true', 0],
      ['cd "$WT" && stim ios', 0],
      ['cd ~/app && stim ios', 0],
      ['cd /pri[v]ate/tmp && pwd', 0],
      ['cd ./worktrees/ru\\\nn && pwd', 0],
      ['cd - && stim ios', 0],
      ['env AGENT_DEVICE_SESSION=$(claim-session) agent-device close', 0],
      ['env AGENT_DEVICE_SESSION=$SESSION agent-device close', 0],
      ['env -i AGENT_DEVICE_SESSION=run agent-device close', 0],
      ['env AGENT_DEVICE_SESSION=run other-tool', 0],
      ['echo env AGENT_DEVICE_SESSION=run agent-device close', 0],
      ['echo done # ; env AGENT_DEVICE_SESSION=run agent-device snapshot', 0],
      ["'AGENT_DEVICE_SESSION=run' agent-device close", 127],
      ['cat <<EOF\nenv AGENT_DEVICE_SESSION=run agent-device close\nEOF', 0],
      ['cd "unterminated && stim ios', 0],
    ];
    for (const [command, exitCode] of unchanged) {
      expect(benchmarkCommandPresentation(command, exitCode)).toBeUndefined();
    }
  });
});
