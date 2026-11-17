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
