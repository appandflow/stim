import { atMostUnscripted, guideBytes, matches, observe, ran, ranAfter } from '../graders.ts';
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
    const runs = input.invocations.filter((each) => matches(each, { argv: ['ios'] }));
    const [first, second] = runs;
    const reloaded =
      first !== undefined &&
      second !== undefined &&
      input.invocations.some(
        (each) =>
          matches(each, { argv: ['reload'] }) && each.startedAt >= first.endedAt && each.endedAt <= second.startedAt,
      );
    return [
      ran(input, { argv: ['ios'] }),
      {
        name: 'no second stim ios before a stim reload',
        pass: second === undefined || reloaded,
        detail: `${runs.length} ios runs${second === undefined ? '' : reloaded ? ', reload first' : ', no reload first'}`,
      },
      atMostUnscripted(input, 2),
      observe('stim ios runs', runs.length),
      observe(
        'ran stim logs --errors after ios',
        ranAfter(input, { argv: ['ios'] }, { argv: ['logs'], predicate: (each) => each.argv.includes('--errors') })
          .pass,
      ),
      observe(
        'ran stim reload',
        input.invocations.some((each) => each.argv[0] === 'reload'),
      ),
      observe('guide bytes read', guideBytes(input.invocations)),
    ];
  },
};
