export const TUTORIAL_REPO = 'appandflow/stim-tutorial';

const TUTORIAL_BUNDLE_ID = 'dev.stim.tutorial';

export const TUTORIAL_RESTART_PROMPT = 'Restart the Stim tutorial.';

/**
 * The requests Stim Desktop offers to copy, written the way a developer would ask. {base}, {tour} and {machine} are
 * filled in by Desktop. Only the first and last name a guide section, which holds the folder and cleanup safety rules.
 */
export const TUTORIAL_ASKS = {
  begin: `Clone ${TUTORIAL_REPO} into {base} and run it on iOS with stim. Use a fresh folder: if {base} already exists or is inside another git repository, stop and ask me for another folder, and never git add in my own repo. Follow stim guide tutorial run.`,
  agent: 'Open the app on the iOS simulator, take a screenshot and confirm the title color.',
  machine: 'Build the app for iOS on {machine} with stim instead of on this Mac. Do not approve or pair anything.',
  finish:
    "I'm done with these experiments in {base} and don't need the changes. Stop the apps and remove only the worktrees you made for them, and keep the clone. Follow stim guide tutorial finish.",
  share: `Open a pull request to ${TUTORIAL_REPO} with my title color change, and include a screenshot of it running in the simulator. See stim guide tutorial share.`,
  retry: 'The first iOS build of the tutorial app in {base} failed. Find out why and run it on iOS again.',
};

export const TUTORIAL_STEPS: {
  id: string;
  title: string;
  who: 'agent' | 'you' | 'both';
  optional: boolean;
  ask: string | null;
  section: string | null;
  commands: string[];
}[] = [
  {
    id: 'begin',
    title: 'Get the Test App',
    who: 'agent',
    optional: false,
    ask: TUTORIAL_ASKS.begin,
    section: 'run',
    commands: [],
  },
  {
    id: 'build',
    title: 'Make a Change',
    who: 'you',
    optional: false,
    ask: null,
    section: null,
    commands: [],
  },
  {
    id: 'parallel',
    title: 'Change It Again in Parallel',
    who: 'you',
    optional: false,
    ask: null,
    section: null,
    commands: [],
  },
  {
    id: 'device',
    title: 'Live View and Control',
    who: 'you',
    optional: true,
    ask: null,
    section: null,
    commands: ['stim status'],
  },
  {
    id: 'agent',
    title: 'Agent Actions and Replay',
    who: 'agent',
    optional: true,
    ask: TUTORIAL_ASKS.agent,
    section: null,
    commands: [
      'cd "{tour}"',
      'export AGENT_DEVICE_STATE_DIR="{stateDir}"',
      `agent-device open ${TUTORIAL_BUNDLE_ID} --platform ios --udid {udid}`,
      'agent-device screenshot tutorial.png',
      'agent-device close',
      'stim logs --source agent --tail 10',
    ],
  },
  {
    id: 'logs',
    title: 'App Logs',
    who: 'you',
    optional: true,
    ask: null,
    section: null,
    commands: ['stim logs --errors', 'stim logs --grep stim:tutorial'],
  },
  {
    id: 'phone',
    title: 'Watch on Your Phone',
    who: 'you',
    optional: true,
    ask: null,
    section: null,
    commands: [],
  },
  {
    id: 'machine',
    title: 'Build on Another Mac',
    who: 'both',
    optional: true,
    ask: TUTORIAL_ASKS.machine,
    section: null,
    commands: ['cd "{tour}"', 'stim ios --remote-build "{machine}" --no-build-cache'],
  },
  {
    id: 'finish',
    title: 'Finish and Archive',
    who: 'agent',
    optional: false,
    ask: TUTORIAL_ASKS.finish,
    section: 'finish',
    commands: [
      'cd "{tour}"',
      'stim stop',
      'cd "{second}"',
      'stim stop',
      'cd "{base}"',
      'stim worktree remove "{tour}"',
      'stim worktree remove "{second}"',
    ],
  },
  {
    id: 'share',
    title: 'Share Your Finish',
    who: 'you',
    optional: true,
    ask: TUTORIAL_ASKS.share,
    section: 'share',
    commands: [
      'xcrun simctl io booted screenshot finish.png',
      `gh pr create --repo ${TUTORIAL_REPO} --attach "finish.png#The change running in the simulator"`,
    ],
  },
];
