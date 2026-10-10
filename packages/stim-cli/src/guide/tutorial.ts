import { TUTORIAL_VERSION } from '@stim-cli/core/state';
import { TUTORIAL_BUNDLE_ID, TUTORIAL_REPO, TUTORIAL_RESTART_PROMPT } from './tutorial-data.ts';
import type { GuideTopic } from './types.ts';

const paths = `Use {base} = ~/stim-tutorial unless the user named another folder. Expand ~
to the absolute home path when substituting inside quotes. Keep the tutorial
outside the user's own projects.`;

const local = `The tutorial runs on this Mac. Every time you run the tutorial app on iOS
from a worktree of {base}, use stim ios --remote local --remote-build local,
even when the user's settings would place the device or the build on another
Mac. Only an explicit request to build on another Mac changes the build, with
stim ios --remote local --remote-build "<machine>"; the device stays here.`;

const screenshots = `Before and after screenshots, for a pull request: in each change's worktree,
run the app on iOS before you edit anything, open it with agent-device and save
the screen, then make the change and, once Fast Refresh applies it, save the
same screen on the same device:

  mkdir -p .expo/screenshots
  export AGENT_DEVICE_STATE_DIR="<agentDevice.stateDir from stim status --json>"
  agent-device open ${TUTORIAL_BUNDLE_ID} --platform ios --udid <ios.udid>
  agent-device screenshot .expo/screenshots/before.png
  (make the change)
  agent-device screenshot .expo/screenshots/after.png

Without agent-device, use xcrun simctl io <ios.udid> screenshot
.expo/screenshots/before.png, using that worktree's udid from stim status --json,
never booted. Take both with the same tool so they match in size. .expo/ is
ignored and outside the native fingerprint, so the files are never committed,
never change the build, and never block stim worktree remove. Keep each PNG under 1 MB.`;

const tutorial: GuideTopic = {
  summary: 'A cloned test app: a first build, a second change in parallel with a cache hit, and cleanup',
  sectionHint: 'run',
  preamble: () => `STIM TUTORIAL

The tutorial clones ${TUTORIAL_REPO}, a tiny Expo app, into {base}; the clone is
never run, and only the optional delete step removes it. The user then asks for a visual change, which runs in a
linked worktree of {base} with its own simulator and Metro port. Only the clone,
the optional share and the cleanup need this guide: the changes are ordinary
requests, so follow stim guide agent for them, and check each change on the
device.

${local}

"Follow stim guide tutorial run" means stim guide tutorial run.
"Follow stim guide tutorial finish" means stim guide tutorial finish.
"Follow stim guide tutorial delete" means stim guide tutorial delete.
"${TUTORIAL_RESTART_PROMPT}" means stim guide tutorial restart.

${paths}

Never pair phones, approve machines, or grant access on the user's behalf.`,
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

${screenshots}

Check each change on the device with agent-device in that same session, after
the after screenshot, so Stim Desktop records your actions and the user can
replay them: tap tap-button, toggle dark-accent-switch, type a name in
name-input, then take a screenshot (agent-device screenshot
.expo/screenshots/checked.png) and confirm the change. Refs expire after each
action: run agent-device snapshot -i before every action and use the ref it
reports for that testID. When agentDevice.installed is false in stim status
--json, do not install agent-device unasked: check the change with the build
result and stim logs --errors, and tell the user that agent-device would let
you tap through the app.

PAUSE: end the turn. Tell the user to ask for a visual change next, such as
making the title purple, in their own words. It runs in a new linked worktree
of {base} (stim guide agent), and its first iOS build takes a few minutes.`,
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

  cd "{tour}"
  stim stop
  cd "{second}"
  stim stop
  cd "{base}"
  stim worktree remove "{tour}"
  stim worktree remove "{second}"

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
      summary: 'Optionally open a public pull request with before and after screenshots of the change',
      body: () => `SHARE YOUR FINISH (OPTIONAL)

Only on the user's explicit request, which the share prompt is, and before the
finish step removes the worktrees. The pull request is public: the user's GitHub
name and change appear on ${TUTORIAL_REPO}, and a bot replies and closes it. It
needs gh signed in. Never open it unprompted or from any other step.

Work from the worktree holding the user's change, {tour}. Commit only the
change's files there, never .expo/screenshots/. Fork the repository and push the
branch to the fork, since the user has no write access:

  gh repo fork ${TUTORIAL_REPO} --remote --remote-name fork
  git push -u fork HEAD

Screenshots: use .expo/screenshots/before.png and .expo/screenshots/after.png from that
worktree (stim guide tutorial run). If either is missing, take it now on the same
device, that worktree's ios.udid from stim status --json, never booted, with the
app running from the branch (run it again first if needed). For
a missing before, show the original screen with
git checkout origin/main -- <changed files>, capture it once Fast Refresh applies,
then restore the change with git checkout HEAD -- <changed files> and capture the
after again with the same tool, so both match in size.

Body: write .expo/screenshots/body.md from the clone's
.github/pull_request_template.md, keeping its headings, table and Stim link and
dropping its <!-- --> comments. An older clone without the template gets the
same parts, in this order:
- the first line: one sentence saying what changed and why;
- the table, with ![Before](./.expo/screenshots/before.png) and
  ![After](./.expo/screenshots/after.png) in its cells;
- a How it was verified section, with only what you observed: Device is ios.name from
  stim status --json; Readiness is the "app reported ready" time stim ios
  printed; Build is lastBuilds.ios.durationMs and whether lastBuilds.ios.cacheHit
  was local or remote (a cache hit) or false (a full build), plus, when you know
  it, whether the second worktree's first iOS build was a cache hit; Logs is the
  result of stim logs --errors. Drop a line you did not observe rather than
  guess it;
- the closing line: Built and verified with [Stim](https://github.com/appandflow/stim).

Open the pull request from {tour}:

  gh pr create --repo ${TUTORIAL_REPO} --title "<the one-line summary>" \\
    --body-file .expo/screenshots/body.md \\
    --attach ".expo/screenshots/before.png#Before" --attach ".expo/screenshots/after.png#After"

--attach uploads each image and rewrites the matching ./.expo/screenshots/ reference in
the body to the uploaded file, so the table shows both images. gh 2.99.0
(2026-09-01) has --attach; confirm with gh pr create --help rather than guessing
a version. When gh has no --attach, open the pull request with --body-file alone
and tell the user to drag the two images into the table on GitHub. Give the user
the pull request URL.`,
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
  },
};

export default tutorial;
