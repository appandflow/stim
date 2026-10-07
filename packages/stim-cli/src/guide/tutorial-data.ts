export const TUTORIAL_PINS = {
  createExpoApp: '5.0.0',
  template: 'expo-template-blank@58.0.15',
};

export const TUTORIAL_FILES = {
  'App.js': `import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { TITLE_COLOR } from './theme';

const TAG = '[stim:tutorial]';

function Button({ label, onPress }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [note, setNote] = useState('');

  useEffect(() => {
    console.log(\`\${TAG} title color=\${TITLE_COLOR}\`);
  }, [TITLE_COLOR]);

  const logError = () => {
    console.error(\`\${TAG} error-button test error\`);
    setNote('Logged an error.');
  };

  const crash = () => {
    setTimeout(() => {
      throw new Error(\`\${TAG} crash-button uncaught test error\`);
    }, 0);
  };

  const slowRequest = async () => {
    const started = Date.now();
    setNote('Waiting 3 seconds...');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const elapsed = Date.now() - started;
    console.warn(\`\${TAG} slow-request \${elapsed}ms\`);
    setNote(\`Slow request took \${elapsed}ms.\`);
  };

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: TITLE_COLOR }]}>Stim Tutorial</Text>
      <Text style={styles.body}>Tap a button, then look at Stim Desktop &gt; Logs.</Text>
      <Button label="Log an error" onPress={logError} />
      <Button label="Crash me" onPress={crash} />
      <Button label="Slow request" onPress={slowRequest} />
      <Text style={styles.note}>{note}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 32, fontWeight: '700', marginBottom: 8 },
  body: { fontSize: 16, color: '#4b5563', textAlign: 'center', marginBottom: 24 },
  button: { backgroundColor: '#111827', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 28, marginBottom: 12 },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  note: { marginTop: 12, fontSize: 15, color: '#374151' },
});
`,
  'theme.js': `export const TITLE_COLOR = '#1f2937';
`,
  'app.json': `{
  "expo": {
    "name": "Stim Tutorial",
    "slug": "stim-tutorial",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "dev.stim.tutorial"
    },
    "android": {
      "adaptiveIcon": {
        "backgroundColor": "#E6F4FE",
        "foregroundImage": "./assets/android-icon-foreground.png",
        "backgroundImage": "./assets/android-icon-background.png",
        "monochromeImage": "./assets/android-icon-monochrome.png"
      },
      "package": "dev.stim.tutorial"
    },
    "web": {
      "favicon": "./assets/favicon.png"
    },
    "extra": {
      "stimTutorial": 1
    }
  }
}
`,
  '.gitignore': `/ios
/android
/tutorial*.ad
/tutorial*.png
`,
};

export const TUTORIAL_PROMPTS = {
  begin: 'Run the Stim tutorial.',
  rebuild: 'Continue the Stim tutorial: rebuild',
  agent: 'Continue the Stim tutorial: agent',
  refresh: 'Continue the Stim tutorial: refresh',
  machine: 'Continue the Stim tutorial: machine',
  finish: 'Continue the Stim tutorial: finish',
};

export const TUTORIAL_RESTART_PROMPT = 'Restart the Stim tutorial.';

export const TUTORIAL_STEPS: {
  id: string;
  title: string;
  who: 'agent' | 'you' | 'both';
  optional: boolean;
  prompt: string | null;
  section: string | null;
  manual: string[];
}[] = [
  {
    id: 'begin',
    title: 'Create the tutorial',
    who: 'agent',
    optional: false,
    prompt: TUTORIAL_PROMPTS.begin,
    section: 'run',
    manual: [
      'base="{base}"',
      'mkdir -p "${base%/*}"',
      'if [ ! -e "$base" ]; then',
      'cd "${base%/*}"',
      'if git -C "${base%/*}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "Stop: inside another repository. Ask for another folder; never git add in the user repository."; exit 1; fi',
      `npx --yes create-expo-app@${TUTORIAL_PINS.createExpoApp} stim-tutorial --template ${TUTORIAL_PINS.template} --no-install --no-agents-md --yes`,
      'cd "$base"',
      'stim guide tutorial app',
      ...Object.entries(TUTORIAL_FILES).flatMap(([name, content]) =>
        [`cat ${name === '.gitignore' ? '>>' : '>'} ${name} <<'STIM_TUTORIAL_EOF'`].concat(
          content.trimEnd().split('\n'),
          'STIM_TUTORIAL_EOF',
        ),
      ),
      'npm install --prefer-offline',
      'npm pkg set scripts.ios="expo run:ios" scripts.android="expo run:android"',
      'git init',
      'git add -A',
      'git -c user.name=Stim -c user.email=stim@localhost -c commit.gpgsign=false commit -m "Stim tutorial"',
      'else',
      'cd "$base"',
      `node -e 'const fs = require("node:fs"); const app = fs.existsSync("app.json") ? JSON.parse(fs.readFileSync("app.json", "utf8")) : null; if (app?.expo?.extra?.stimTutorial !== ${JSON.parse(TUTORIAL_FILES['app.json']).expo.extra.stimTutorial}) { console.error("Stop: existing non-tutorial folder or another version. Ask for another folder; never overwrite or delete it."); process.exit(1); }'`,
      `git rev-parse --show-toplevel | node -e 'const fs = require("node:fs"); const root = fs.readFileSync(0, "utf8").trim(); if (fs.realpathSync(root) !== fs.realpathSync(process.cwd())) { console.error("Stop: inside another repository. Ask for another folder; never git add in the user repository."); process.exit(1); }'`,
      'fi',
    ],
  },
  {
    id: 'sidebar',
    title: 'Workspace in sidebar',
    who: 'you',
    optional: false,
    prompt: null,
    section: null,
    manual: [],
  },
  {
    id: 'build',
    title: 'First iOS build',
    who: 'you',
    optional: false,
    prompt: null,
    section: null,
    manual: [
      'cd "{base}"',
      'git worktree add -B stim-tutorial/tour "{tour}" HEAD',
      'cd "{tour}"',
      'stim worktree warm',
      'stim guide agent',
      'stim doctor --platform ios',
      'stim start',
      'stim ios',
    ],
  },
  {
    id: 'rebuild',
    title: 'Rebuild from cache',
    who: 'agent',
    optional: false,
    prompt: TUTORIAL_PROMPTS.rebuild,
    section: 'rebuild',
    manual: ['cd "{tour}"', 'stim ios', 'stim status --json'],
  },
  {
    id: 'device',
    title: 'Live view and control',
    who: 'you',
    optional: false,
    prompt: null,
    section: null,
    manual: ['stim status'],
  },
  {
    id: 'logs',
    title: 'App logs',
    who: 'you',
    optional: false,
    prompt: null,
    section: null,
    manual: ['stim logs --errors', "stim logs --grep '\\[stim:tutorial\\]'"],
  },
  {
    id: 'agent',
    title: 'Agent actions and replay',
    who: 'agent',
    optional: false,
    prompt: TUTORIAL_PROMPTS.agent,
    section: 'agent',
    manual: [
      'cd "{tour}"',
      'export AGENT_DEVICE_STATE_DIR="{stateDir}"',
      'stim status --json',
      'read -r iosUdid',
      'agent-device open dev.stim.tutorial --platform ios --udid "$iosUdid" --save-script=tutorial.ad',
      'agent-device react-native dismiss-overlay || true',
      `agent-device press 'label="Log an error"' --settle`,
      'agent-device screenshot tutorial.png',
      'agent-device close',
      "grep -v -e 'target-v1' -e 'dismiss-overlay' tutorial.ad > tutorial-replay.ad",
      'agent-device replay tutorial-replay.ad',
      'stim logs --source agent --tail 10',
    ],
  },
  {
    id: 'refresh',
    title: 'Fast Refresh',
    who: 'agent',
    optional: false,
    prompt: TUTORIAL_PROMPTS.refresh,
    section: 'refresh',
    manual: [
      'cd "{tour}"',
      "cat > theme.js <<'STIM_TUTORIAL_EOF'",
      "export const TITLE_COLOR = '#7c3aed';",
      'STIM_TUTORIAL_EOF',
      'sleep 6',
      'stim logs --errors',
      "stim logs --grep 'title color'",
    ],
  },
  {
    id: 'phone',
    title: 'Watch on your phone',
    who: 'you',
    optional: true,
    prompt: null,
    section: null,
    manual: [],
  },
  {
    id: 'machine',
    title: 'Build on another Mac',
    who: 'both',
    optional: true,
    prompt: TUTORIAL_PROMPTS.machine,
    section: 'machine',
    manual: ['cd "{tour}"', 'stim ios --build-machine "{machine}" --no-build-cache'],
  },
  {
    id: 'finish',
    title: 'Finish and archive',
    who: 'agent',
    optional: false,
    prompt: TUTORIAL_PROMPTS.finish,
    section: 'finish',
    manual: [
      'git -C "{tour}" checkout -- theme.js',
      'cd "{tour}"',
      'stim stop',
      'cd "{base}"',
      'stim worktree remove "{tour}"',
    ],
  },
];
