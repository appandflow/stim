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
  finish:
    "I'm done with these experiments in {base} and don't need the changes. Stop the apps and remove the worktrees {worktrees}, and keep the clone. Follow stim guide tutorial finish.",
  delete:
    'Remove the Stim tutorial: remove its worktrees and the clone at {base} with stim worktree remove, then delete {base}. Follow stim guide tutorial delete.',
  share: `Open a pull request to ${TUTORIAL_REPO} with my title color change, with before and after screenshots from the simulator. See stim guide tutorial share.`,
  retry: 'The first iOS build of the tutorial app in {tour} failed. Find out why and run it on iOS again.',
};

export const TUTORIAL_STEPS: {
  id: string;
  title: string;
  who: 'agent' | 'you' | 'both';
  optional: boolean;
  ask: string | null;
  section: string | null;
}[] = [
  {
    id: 'begin',
    title: 'Get the Test App',
    who: 'agent',
    optional: false,
    ask: TUTORIAL_ASKS.begin,
    section: 'run',
  },
  {
    id: 'build',
    title: 'Make a Change',
    who: 'you',
    optional: false,
    ask: null,
    section: null,
  },
  {
    id: 'parallel',
    title: 'Change It Again in Parallel',
    who: 'you',
    optional: false,
    ask: TUTORIAL_ASKS.parallel,
    section: null,
  },
  {
    id: 'device',
    title: 'Live View and Control',
    who: 'you',
    optional: true,
    ask: null,
    section: null,
  },
  {
    id: 'agent',
    title: 'Agent Actions and Replay',
    who: 'you',
    optional: true,
    ask: null,
    section: null,
  },
  {
    id: 'logs',
    title: 'App Logs',
    who: 'you',
    optional: true,
    ask: null,
    section: null,
  },
  {
    id: 'phone',
    title: 'Watch on Your Phone',
    who: 'you',
    optional: true,
    ask: null,
    section: null,
  },
  {
    id: 'share',
    title: 'Share Your Finish',
    who: 'you',
    optional: true,
    ask: TUTORIAL_ASKS.share,
    section: 'share',
  },
  {
    id: 'finish',
    title: 'Finish and Archive',
    who: 'agent',
    optional: false,
    ask: TUTORIAL_ASKS.finish,
    section: 'finish',
  },
  {
    id: 'delete',
    title: 'Delete the Test App',
    who: 'agent',
    optional: true,
    ask: TUTORIAL_ASKS.delete,
    section: 'delete',
  },
];
