import { TUTORIAL_VERSION } from '@stim-cli/core/state';
import { TUTORIAL_REPO, TUTORIAL_RESTART_PROMPT, TUTORIAL_STEPS } from './tutorial-data.ts';
import type { GuideTopic } from './types.ts';

const paths = `Use {base} = ~/stim-tutorial unless the user named another folder. Expand ~
to the absolute home path when substituting inside quotes. Keep the tutorial
outside the user's own projects.`;

const local = `The tutorial runs on this Mac. Every time you run the tutorial app on iOS
from a worktree of {base}, use stim ios --remote local --remote-build local,
even when the user's settings would place the device or the build on another
Mac. Only an explicit request to build on another Mac changes the build, with
stim ios --remote local --remote-build "<machine>"; the device stays here.`;

function commands(id: string): string {
  return TUTORIAL_STEPS.find((step) => step.id === id)!.commands.join('\n');
}

const tutorial: GuideTopic = {
  summary: 'A cloned test app: a first build, a second change in parallel with a cache hit, and cleanup',
  sectionHint: 'run',
  preamble: () => `STIM TUTORIAL

The tutorial clones ${TUTORIAL_REPO}, a tiny Expo app, into {base}; the clone is
never run, and only the optional delete step removes it. The user then asks for a visual change, and for another
change while the first builds. Each change runs in its own linked worktree of
{base}, so each has its own simulator and Metro port, and the second worktree's
first iOS build reuses the first one's native build. Only the clone, the
optional share and the cleanup need this guide: the changes are ordinary
requests, so follow stim guide agent for them, and check each change on the
device.

${local}

"Follow stim guide tutorial run" means stim guide tutorial run.
"Follow stim guide tutorial finish" means stim guide tutorial finish.
"Follow stim guide tutorial delete" means stim guide tutorial delete.
"${TUTORIAL_RESTART_PROMPT}" means stim guide tutorial restart.

${paths}

Never pair phones, approve machines, or grant access on the user's behalf.
For commands to type yourself, read stim guide tutorial manual.`,
  sections: {
    run: {
      summary: 'Clone the test app into a fresh folder and install its dependencies',
      body: () => `RUN THE TUTORIAL

${paths}

Folder safety: if {base} does not exist, clone into it. If it exists, reuse it
only when all of these hold: app.json has expo.extra.stimTutorial equal to
${TUTORIAL_VERSION}, git remote get-url origin names ${TUTORIAL_REPO}, git
rev-parse --show-toplevel equals {base}, and git status --porcelain prints
nothing. Then skip the clone, install its dependencies (npm ci), run stim doctor
--platform ios there, and continue at PAUSE. For any other existing folder (another
repository, local changes, no tutorial marker), stop and ask the user for
another folder; never overwrite or delete it. Before cloning, check the parent folder:
create it if absent, then run git -C <parent> rev-parse --is-inside-work-tree.
If that succeeds, the folder is inside another repository: stop and ask the
user for another folder. Never git add in the user's repo.

Then, from the parent folder, run:

  git clone https://github.com/${TUTORIAL_REPO}.git stim-tutorial

Check that app.json in the clone has expo.extra.stimTutorial equal to
${TUTORIAL_VERSION}. If it does not, report the mismatch and stop; the user needs a newer Stim.
Enter the clone and install its dependencies (npm ci) so the worktrees made for
the changes inherit them, then run stim doctor --platform ios there: it registers
the clone with Stim so Stim Desktop sees it, and builds or boots nothing. Do not
run the app: the clone is only the base for the user's changes; only the optional
delete step removes it.
Report the findings of stim doctor and do not act on them: no SimSlim install, no
--fix, nothing that changes the machine during the tutorial. On npm or network failure, report stderr
and stop.

${local}

PAUSE: end the turn. Tell the user to ask for a visual change next, such as
making the title purple, in their own words. Each change runs in a new linked
worktree of {base} (stim guide agent), and its first iOS build takes a few
minutes.`,
    },
    finish: {
      summary: 'Stop and remove the two tutorial worktrees, keeping the clone',
      body: () => `FINISH

${paths}

The worktrees to remove are the two the tutorial tracked: the linked
worktrees of {base} made for the user's changes. The finish request names them
as {tour} and {second}. Never touch any other worktree, an earlier tutorial
clone, or the clone itself. For each, stop from its path, then remove it from
the clone:

${commands('finish')}

Use a plain remove first. The user's finish request says they do not need the
changes, which is the consent stim guide agent asks for before worktree remove
--force, for exactly those two paths: if the plain remove refuses one of them
only because of uncommitted changes or commits found nowhere else, remove that
worktree with --force. Never use --force on the clone or on any other
worktree, and on any other refusal report it and stop. Keep the clone: the
optional delete step removes it only when the user asks (stim guide tutorial
delete).

If archive is enabled, tell the user the worktrees appear under Archived in
Stim Desktop. With archive disabled, report removal without promising an
archive. Without Desktop, inspect stim status --json for the removed
environments. End the turn.`,
    },
    delete: {
      summary: 'Remove the tutorial worktrees and the clone through Stim, then delete the folder',
      body: () => `DELETE THE TEST APP (OPTIONAL)

${paths}

Only on the user's explicit request, which the delete prompt is. It covers
{base} and its linked worktrees, nothing else. Remove them through Stim so their
simulators, Metro ports and Stim records are torn down before the files go.

First check that {base}/app.json has expo.extra.stimTutorial. If it does not,
{base} is not the tutorial clone: report it and stop.

List the worktrees with git -C "{base}" worktree list. For each linked worktree
(every entry except {base} itself), run stim stop from its path, then
stim worktree remove "<path>" from {base}. Never use --force here: the delete
request does not say which changes the user can lose. If a remove refuses, report
it and stop without deleting anything, so the user can decide about that
worktree.

Then, from {base}, run stim stop and stim worktree remove "{base}". On the
source checkout it reclaims the Stim environment and leaves the files. If it
refuses, report it and stop. Only after it succeeds, from the parent folder,
delete the clone:

  rm -rf "{base}"

Never use --force in this step, and never delete any path other than {base}. Report
what you removed and end the turn.`,
    },
    share: {
      summary: 'Optionally open a public pull request with a screenshot of the change',
      body: () => `SHARE YOUR FINISH (OPTIONAL)

Only on the user's explicit request, which the share prompt is, and before the
finish step removes the worktrees. The pull request is public: the user's GitHub
name and change appear on ${TUTORIAL_REPO}, and a bot replies and closes it. It
needs gh signed in. Never open it unprompted or from any other step.

Work from the worktree holding the user's change, {tour}. Commit the change
there, fork the repository and push the branch to the fork, since the user has
no write access:

  gh repo fork ${TUTORIAL_REPO} --remote --remote-name fork
  git push -u fork HEAD

Screenshot: take a PNG under 1 MB of the app showing the change, with
agent-device screenshot when it is installed, otherwise
xcrun simctl io <ios.udid> screenshot finish.png, using the udid of that
worktree from stim status --json, never booted. If the app is no longer
running, run it again from the branch first.

Open the pull request with gh pr create --repo ${TUTORIAL_REPO} --fill. Put one
short line with the build time and whether the second worktree's first iOS build
was a cache hit, when you know them from stim status --json or stim stats, in the
commit message body (git commit -m "<title>" -m "<that line>"), so --fill carries it
into the pull request body.

Attach the screenshot with gh: gh pr create --attach "finish.png#The change
running in the simulator" uploads the image and appends it to the body. gh
2.99.0 (2026-09-01) has --attach; confirm with gh pr create --help rather than
guessing a version. When gh has no --attach, commit the PNG on the PR branch as
finish/<github-login>.png before pushing and embed it in the body with a
relative link: ![the change](finish/<github-login>.png).`,
    },
    restart: {
      summary: 'Start the tutorial again without removing anything',
      body: () => `RESTART

${paths}

For "${TUTORIAL_RESTART_PROMPT}", remove nothing: the user may still want the
earlier worktrees. Finish only removes the pair named in its request, so leave
any earlier worktrees and tell the user they stay until they ask for each by
path; never use --force for them. Reuse the clone at {base} only if its
stimTutorial marker equals ${TUTORIAL_VERSION}; otherwise follow stim guide
tutorial run into a fresh folder. Pause as run instructs. Stim Desktop starts
over: only worktrees and builds after the restart count.`,
    },
    manual: {
      summary: 'The commands behind each step, for typing yourself',
      body: () => `MANUAL TUTORIAL

${paths}

Replace {base}, {tour} and {second} with absolute paths: {base} is the clone,
{tour} the first worktree and {second} the second. For Agent Actions, replace
{stateDir} with agentDevice.stateDir from stim ios or stim status --json and
{udid} with the workspace's ios.udid. Clone with git
clone https://github.com/${TUTORIAL_REPO}.git into a fresh folder outside any
repository. Each change runs in its own worktree of that clone (stim guide
agent); the clone itself is never run. Run each worktree on iOS with
stim ios --remote local --remote-build local so it stays on this Mac.

${TUTORIAL_STEPS.map((step) => `${step.title}${step.optional ? ' (optional)' : ''}\n\n${step.commands.length ? `\`\`\`sh\n${step.commands.join('\n')}\n\`\`\`` : 'Ask your agent in your own words, or observe this step in Stim Desktop.'}`).join('\n\n')}

Finish removes only the two tutorial worktrees, never the clone; stim guide tutorial finish says when --force is allowed for them.`,
    },
  },
};

export default tutorial;
