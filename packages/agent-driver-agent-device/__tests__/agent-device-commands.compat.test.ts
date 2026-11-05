import { execFileSync } from 'node:child_process';
import { DEVICE_COMMAND_RULES, REFUSED_DEVICE_COMMANDS } from '../device-policy.ts';
import { resolveAgentDevice } from '../driver.ts';

const invocation = resolveAgentDevice(process.env);

function help(...topic: string[]): string {
  return execFileSync(invocation.command, [...invocation.args, 'help', ...topic], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
    timeout: 30_000,
  });
}

function block(text: string, heading: string): string[] {
  const start = text.split('\n').indexOf(heading);
  if (start < 0) return [];
  const lines = text.split('\n').slice(start + 1);
  const end = lines.indexOf('');
  return end < 0 ? lines : lines.slice(0, end);
}

const catalog = block(help('commands'), 'Commands:').flatMap((line) => /^ {2}([a-z][a-z-]*)/.exec(line)?.[1] ?? []);

test('every agent-device command is either a hosted device command or refused with a reason', () => {
  expect(catalog.length).toBeGreaterThan(0);
  const unclassified = catalog.filter(
    (name) => !Object.hasOwn(DEVICE_COMMAND_RULES, name) && !Object.hasOwn(REFUSED_DEVICE_COMMANDS, name),
  );
  expect(unclassified).toEqual([]);
  expect(Object.keys(DEVICE_COMMAND_RULES).filter((name) => !catalog.includes(name))).toEqual([]);
  expect(Object.keys(DEVICE_COMMAND_RULES).filter((name) => Object.hasOwn(REFUSED_DEVICE_COMMANDS, name))).toEqual([]);
});

test.each(Object.entries(DEVICE_COMMAND_RULES))(
  'classifies every flag agent-device help lists for %s',
  (command, rule) => {
    const listed = block(help(command), 'Command flags:').flatMap((line) => /^ {2}(-[\w-]+)/.exec(line)?.[1] ?? []);
    expect(listed.toSorted()).toEqual(Object.keys({ ...rule.flags, ...rule.refused }).toSorted());
  },
);
