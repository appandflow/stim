import {
  atMostUnscripted,
  editPosition,
  guideBytes,
  IOS_LAUNCH,
  launchesOutsideStim,
  matches,
  neverAttempts,
  observe,
  ran,
  ranAfter,
  stimAction,
} from '../graders.ts';
import type { EvalCase } from '../types.ts';
import { expoApp, workspaceRules } from './fixtures.ts';

const BROKEN_APP =
  "import { Text, View } from 'react-native';\n\nconst settings: { title: string } | undefined = undefined;\n\nexport default function App() {\n  return (\n    <View>\n      <Text>{settings!.title}</Text>\n    </View>\n  );\n}\n";

const IOS_STDOUT =
  'WARNING: com.example.demo on stim-demo (BF2A..), Metro port 8082; app errors detected; inspect the error above\n';

const IOS_STDERR =
  '  build       cache hit (local) 4.1s\n' +
  '  install     com.example.demo on stim-demo (iPhone 17 / iOS 26.5)\n' +
  '  verify      bundle loaded, process alive, stable for 3s -- the first screen may still be rendering (6.2s total)\n' +
  '  launch      1 app error during launch\n' +
  "  launch      TypeError: Cannot read property 'title' of undefined (App.tsx:8)\n" +
  '  remedy      The native app is still running. Fix the JavaScript or TypeScript error; Fast Refresh should apply the edit. If the error screen remains, run `stim reload ios`. Do not run `stim ios` unless native inputs changed or the app process exits.\n';

export const runtimeError: EvalCase = {
  id: 'runtime-error',
  prompt: 'Run the app on the iOS simulator and make sure it starts without errors.',
  workspace: { files: { ...expoApp('demo'), 'App.tsx': BROKEN_APP } },
  script: [
    ...workspaceRules,
    {
      argv: ['ios'],
      prefix: true,
      stdout: IOS_STDOUT,
      stderr: IOS_STDERR,
      exit: 0,
      source: 'synthetic',
      note: 'Line shapes and the remedy text follow launch.ts and the ios-command.test.ts case for an app error with a live native process; the error, timings and device are invented.',
    },
    {
      argv: ['logs'],
      prefix: true,
      stderr: 'No matching log records\n',
      exit: 0,
      source: 'synthetic',
      note: 'The zero-match human output the guide describes; the scripted stim has no state, so it reads as after the fix.',
    },
    {
      argv: ['reload'],
      prefix: true,
      stdout: 'Reload sent to com.example.demo on stim-demo (BF2A..).\n',
      exit: 0,
      source: 'synthetic',
      note: 'Written by hand.',
    },
  ],
  grade(input) {
    const commands = input.run.commands.map((each) => each.command);
    const launches = commands.flatMap((text, index) => (stimAction(text, 'ios', ['--plan']) ? [index] : []));
    const reloads = commands.flatMap((text, index) => (stimAction(text, 'reload') ? [index] : []));
    const edit = editPosition(input.run, 'App.tsx');
    const first = launches[0];
    const rebuilt =
      first === undefined ? [] : launches.filter((index) => index > first && (edit === null || index < edit));
    const reloadAfterEdit = edit === null ? undefined : reloads.find((index) => index >= edit);
    const relaunches =
      edit === null
        ? []
        : launches.filter((index) => index >= edit && (reloadAfterEdit === undefined || index < reloadAfterEdit));
    return [
      ran(input, IOS_LAUNCH),
      { name: 'edited App.tsx', pass: edit !== null, detail: edit === null ? 'no edit seen' : `after command ${edit}` },
      {
        name: 'reloaded or relaunched through stim after the edit',
        pass: edit !== null && (reloadAfterEdit !== undefined || relaunches.length > 0),
        detail: `${reloads.length} reloads, ${launches.length} launches`,
      },
      {
        name: 'no stim ios rerun before the fix',
        pass: rebuilt.length === 0,
        detail: `${rebuilt.length} reruns before the edit`,
      },
      {
        name: 'at most one stim ios after the edit before a reload',
        pass: relaunches.length <= 1,
        detail: `${relaunches.length} relaunches`,
      },
      neverAttempts(input, 'a launch outside stim', launchesOutsideStim),
      atMostUnscripted(input, 2),
      observe('stim ios runs', input.invocations.filter((each) => matches(each, IOS_LAUNCH)).length),
      observe(
        'ran stim logs --errors after ios',
        ranAfter(input, IOS_LAUNCH, { argv: ['logs'], predicate: (each) => each.argv.includes('--errors') }).pass,
      ),
      observe('guide bytes read', guideBytes(input.invocations)),
    ];
  },
};
