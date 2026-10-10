export const TUTORIAL_REPO = 'appandflow/stim-tutorial';

export const TUTORIAL_BUNDLE_ID = 'dev.stim.tutorial';

export const TUTORIAL_RESTART_PROMPT = 'Restart the Stim tutorial.';

/**
 * The requests Stim Desktop offers to copy, written the way a developer would ask. {base}, {tour} and {worktrees}
 * are filled in by Desktop. A step with a section names the guide section that holds its safety rules.
 */
export const TUTORIAL_ASKS = {
  begin: `Clone ${TUTORIAL_REPO} into {base} and follow stim guide tutorial run.`,
  parallel: 'While that builds, make the Tap me button green in a new worktree and check it on the simulator.',
  agent: 'Open the app on the iOS simulator, take a screenshot and confirm the title color.',
  finish:
    "I'm done with these experiments in {base} and don't need the changes. Stop the apps and remove the worktrees {worktrees}, and keep the clone. Follow stim guide tutorial finish.",
  delete:
    'Remove the Stim tutorial: remove its worktrees and the clone at {base} with stim worktree remove, then delete {base}. Follow stim guide tutorial delete.',
  share: `Open a pull request to ${TUTORIAL_REPO} with my title color change, and include a screenshot of it running in the simulator. See stim guide tutorial share.`,
  retry: 'The first iOS build of the tutorial app in {tour} failed. Find out why and run it on iOS again.',
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
    ask: TUTORIAL_ASKS.parallel,
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
    id: 'share',
    title: 'Share Your Finish',
    who: 'you',
    optional: true,
    ask: TUTORIAL_ASKS.share,
    section: 'share',
    commands: [
      'cd "{tour}"',
      'git commit -am "Tutorial change" -m "Build <time>, second build cache <hit or miss>"',
      'xcrun simctl io {udid} screenshot finish.png',
      `gh repo fork ${TUTORIAL_REPO} --remote --remote-name fork`,
      'git push -u fork HEAD',
      `gh pr create --repo ${TUTORIAL_REPO} --fill --attach "finish.png#The change running in the simulator"`,
    ],
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
    id: 'delete',
    title: 'Delete the Test App',
    who: 'agent',
    optional: true,
    ask: TUTORIAL_ASKS.delete,
    section: 'delete',
    commands: [
      'cd "{base}"',
      'grep stimTutorial app.json',
      'git worktree list',
      'stim stop',
      'stim worktree remove "{base}"',
      'cd ..',
      'rm -rf "{base}"',
    ],
  },
];
