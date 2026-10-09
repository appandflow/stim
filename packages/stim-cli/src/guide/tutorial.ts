import { TUTORIAL_VERSION } from '@stim-cli/core/state';
import { TUTORIAL_REPO, TUTORIAL_RESTART_PROMPT, TUTORIAL_STEPS } from './tutorial-data.ts';
import type { GuideTopic } from './types.ts';

const paths = `Use {base} = ~/stim-tutorial unless the user named another folder. Expand ~
to the absolute home path when substituting inside quotes. Keep the tutorial
outside the user's own projects.`;

function commands(id: string): string {
  return TUTORIAL_STEPS.find((step) => step.id === id)!.commands.join('\n');
}

const tutorial: GuideTopic = {
  summary: 'A cloned test app: a first build, a second change in parallel with a cache hit, and cleanup',
  sectionHint: 'run',
  preamble: () => `STIM TUTORIAL

The tutorial clones ${TUTORIAL_REPO}, a tiny Expo app, and runs it on iOS.
The user then asks for a visual change, and for another change while the first
build runs. Stim works in a worktree for each, so the second workspace has its
own simulator and Metro port and its first iOS build reuses the first one's
native build. Only the first request, the cleanup and an optional share need
this guide: the changes are ordinary requests, so follow stim guide agent for
them, and check each change on the device.

"Follow stim guide tutorial run" means stim guide tutorial run.
"Follow stim guide tutorial finish" means stim guide tutorial finish.
"${TUTORIAL_RESTART_PROMPT}" means stim guide tutorial restart.

${paths}

Never pair phones, approve machines, or grant access on the user's behalf.
For commands to type yourself, read stim guide tutorial manual.`,
  sections: {
    run: {
      summary: 'Clone the test app into a fresh folder and run it on iOS',
      body: () => `RUN THE TUTORIAL

${paths}

Folder safety: use a fresh folder. If {base} exists, stop and ask the user for
another folder; never overwrite or delete it. First check the parent folder:
create it if absent, then run git -C <parent> rev-parse --is-inside-work-tree.
If that succeeds, the folder is inside another repository: stop and ask the
user for another folder. Never git add in the user's repo.

Then, from the parent folder, run:

  git clone https://github.com/${TUTORIAL_REPO}.git stim-tutorial

Check that app.json in the clone has expo.extra.stimTutorial equal to
${TUTORIAL_VERSION}. If it does not, report the mismatch and stop; the user needs a newer Stim.
Enter the clone, run the project's package install (npm install), and follow
stim guide agent to run the app on iOS (stim start, stim ios). Tell the user the
first build can take about four minutes on a cold cache. Relay the Open in Stim
Desktop link printed by stim ios once. On npm or network failure, report stderr
and stop.

PAUSE: end the turn. Ask the user to look at the Build section in Stim Desktop
and then the simulator. Without Desktop use stim status, stim stats and
stim logs --errors. Suggest they ask for a visual change next, such as making
the title purple, in their own words. Leave the workspace running.`,
    },
    finish: {
      summary: 'Stop and remove only the worktrees made for the tutorial changes',
      body: () => `FINISH

${paths}

The user's finish request authorizes removing the worktrees made for the
tutorial's changes, and nothing else. Find them with stim status --json: they
are the tutorial app's workspaces other than the {base} clone. For each, stop
from its path, then remove it from the clone:

${commands('finish')}

Never use --force. On a refusal, report it and stop. Keep the clone. Print
these optional cleanup commands for the user; do not run them:

  rm -rf "{base}"

If archive is enabled, tell the user the worktrees appear under Archived in
Stim Desktop. With archive disabled, report removal without promising an
archive. Without Desktop, inspect stim status --json for the removed
environments. End the turn.`,
    },
    share: {
      summary: 'Optionally open a public pull request with a screenshot of the change',
      body: () => `SHARE YOUR FINISH (OPTIONAL)

Only on the user's explicit request, which the share prompt is. The pull
request is public: the user's GitHub name and change appear on ${TUTORIAL_REPO},
and a bot replies and closes it. It needs gh signed in. Never open it
unprompted or from any other step.

Open it from the branch holding the user's change. In the body, add one short
line with the build time and whether the second worktree's first iOS build was
a cache hit, when you know them from stim status --json or stim stats.

Screenshot: take a PNG under 1 MB of the app showing the change, with
agent-device screenshot when it is installed, otherwise
xcrun simctl io <ios.udid> screenshot finish.png (stim status --json reports
the udid). If the app is no longer running, run it again from the change's
branch first.

Attach it with gh: gh pr create --attach "finish.png#The change running in the
simulator" uploads the image and appends it to the body. gh 2.99.0 (2026-09-01)
has --attach; confirm with gh pr create --help rather than guessing a version.
When gh has no --attach, commit the PNG on the PR branch as
finish/<github-login>.png and embed it in the body with a relative link:
![the change](finish/<github-login>.png).`,
    },
    restart: {
      summary: 'Remove the existing tutorial worktrees safely and start again',
      body: () => `RESTART

${paths}

For "${TUTORIAL_RESTART_PROMPT}", remove the tutorial's worktrees as stim guide
tutorial finish describes, never with --force, keep the clone, then follow
stim guide tutorial run again, reusing the clone only if its stimTutorial
marker equals ${TUTORIAL_VERSION}. Pause after the build as run instructs.`,
    },
    manual: {
      summary: 'The commands behind each step, for typing yourself',
      body: () => `MANUAL TUTORIAL

${paths}

Replace {base}, {tour} and {second} with absolute paths: {base} is the clone,
{tour} the first worktree and {second} the second. For Agent Actions, replace
{stateDir} with agentDevice.stateDir from stim ios or stim status --json and
{udid} with the workspace's ios.udid. For the optional machine step, replace
{machine} with a machine you have already approved, or skip it. Clone with git
clone https://github.com/${TUTORIAL_REPO}.git into a fresh folder outside any
repository, then run the app with stim guide agent.

${TUTORIAL_STEPS.map((step) => `${step.title}${step.optional ? ' (optional)' : ''}\n\n${step.commands.length ? `\`\`\`sh\n${step.commands.join('\n')}\n\`\`\`` : 'Ask your agent in your own words, or observe this step in Stim Desktop.'}`).join('\n\n')}

Finish removes only the tutorial worktrees. Never use --force; report a refusal.`,
    },
  },
};

export default tutorial;
