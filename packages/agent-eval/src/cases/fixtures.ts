import type { ScriptRule } from '../types.ts';

export function expoApp(name: string): Record<string, string> {
  return {
    'package.json': `${JSON.stringify(
      {
        name,
        version: '1.0.0',
        main: 'index.js',
        scripts: { start: 'expo start', ios: 'expo run:ios', android: 'expo run:android' },
        dependencies: { expo: '~58.0.0', react: '19.2.0', 'react-native': '0.88.0' },
      },
      null,
      2,
    )}\n`,
    'app.json': `${JSON.stringify(
      { expo: { name, slug: name, version: '1.0.0', ios: { bundleIdentifier: `com.example.${name}` } } },
      null,
      2,
    )}\n`,
    'index.js':
      "import { registerRootComponent } from 'expo';\nimport App from './App';\n\nregisterRootComponent(App);\n",
    'App.tsx':
      "import { Text, View } from 'react-native';\n\nexport default function App() {\n  return (\n    <View>\n      <Text>Hello</Text>\n    </View>\n  );\n}\n",
    '.gitignore': 'node_modules/\n',
  };
}

export function prefixed(prefix: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [`${prefix}/${path}`, text]));
}

export const workspaceRules: ScriptRule[] = [
  {
    argv: ['worktree', 'warm'],
    stdout: '',
    exit: 0,
    source: 'synthetic',
    note: 'Stdout is empty by the stdout contract for worktree warm; progress on stderr and the exit code are assumed.',
  },
  {
    argv: ['start'],
    prefix: true,
    stdout: 'Metro for this workspace listens on port 8082.\n',
    exit: 0,
    source: 'synthetic',
    note: 'Written by hand; the real line carries more fields.',
  },
  {
    argv: ['doctor'],
    prefix: true,
    stdout:
      'Doctor (all platforms)\n  pressure    normal\n\nToolchain\n  node        ok\n  xcodebuild  ok\n\n0 finding(s).\n',
    exit: 0,
    source: 'synthetic',
    note: 'A short clean report written by hand.',
  },
  {
    argv: ['status'],
    prefix: true,
    stdout: 'demo (feature/eval)  active\n  metro       port 8082, running\n  ios         no device yet\n',
    exit: 0,
    source: 'synthetic',
    note: 'Written by hand; agents often run status first, and the baseline logged it as unscripted in most trials.',
  },
  {
    argv: ['stop'],
    prefix: true,
    stdout: 'Stopped: Metro on port 8082 stopped, stim-demo shut down.\n',
    exit: 0,
    source: 'synthetic',
    note: 'Written by hand.',
  },
];
