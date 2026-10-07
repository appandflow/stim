import {
  TUTORIAL_FILES,
  TUTORIAL_PINS,
  TUTORIAL_PROMPTS,
  TUTORIAL_RESTART_PROMPT,
  TUTORIAL_STEPS,
} from './tutorial-data.ts';
import type { GuideTopic } from './types.ts';

const paths = `Use {base} = ~/stim-tutorial and {tour} = ~/stim-tutorial-tour unless the
user named another parent folder. Expand ~ to the absolute home path when
substituting inside quotes. Keep the tutorial outside the user's project.`;

function commands(id: string): string {
  return TUTORIAL_STEPS.find((step) => step.id === id)!.manual.join('\n');
}

const tutorial: GuideTopic = {
  summary: 'An iOS tutorial: isolated worktree, builds, devices, logs, agent actions, and cleanup',
  sectionHint: 'run',
  preamble: () => `STIM TUTORIAL

Create a small Expo app in its own repository and tour worktree. Follow the
normal Stim flow on iOS, then inspect builds, cache reuse, device control,
logs, agent actions, Fast Refresh, and cleanup.

Run one section per user request. Then end the turn, say what to look at in
Stim Desktop, and give the next prompt. Pause never means stim stop.
"${TUTORIAL_PROMPTS.begin}" means stim guide tutorial run.
"Continue the Stim tutorial: <section>" means stim guide tutorial <section>.
"${TUTORIAL_RESTART_PROMPT}" means stim guide tutorial restart.

Without Stim Desktop, use the simulator, stim status for the workspace and
device, stim logs --errors for errors, and stim stats for build performance.
Follow stim guide agent for doctor, errors, consent, and cleanup. Never pair
phones, approve machines, or grant access on the user's behalf.

${paths}

Start with stim guide tutorial run. For commands to type yourself, read
stim guide tutorial manual. The first run needs network access unless the
required npm and native dependencies are already cached.`,
  sections: {
    run: {
      summary: 'Create or reuse the app, warm a tour worktree, and build on iOS',
      body: () => `RUN THE TUTORIAL

${paths}

Folder safety: create the base folder only if absent. Reuse an existing
folder only if app.json's expo.extra.stimTutorial equals this guide's version,
${JSON.parse(TUTORIAL_FILES['app.json']).expo.extra.stimTutorial}; skip creation and file writes when reusing it. For an existing non-tutorial
folder or another tutorial version, stop and ask the user for another folder.
Never overwrite or delete it.

For a new app, first check the selected parent folder: create it if absent,
then run git -C <parent> rev-parse --is-inside-work-tree. If it succeeds, the
folder is inside another repository: stop and ask the user for another folder.
Never git add in the user's repo. Then, from the parent folder, run:

  npx --yes create-expo-app@${TUTORIAL_PINS.createExpoApp} stim-tutorial --template ${TUTORIAL_PINS.template} --no-install --no-agents-md --yes

Enter the base folder. Run stim guide tutorial app, write its three app files
verbatim, and append its .gitignore lines. Then run:

  npm install --prefer-offline
  npm pkg set scripts.ios="expo run:ios" scripts.android="expo run:android"
  git init
  git add -A
  git -c user.name=Stim -c user.email=stim@localhost -c commit.gpgsign=false commit -m "Stim tutorial"

On reuse, run git rev-parse --show-toplevel in the base folder before adding
a worktree; if it does not equal the base folder, the folder is inside another
repository: stop and ask the user for another folder.

Set the scripts before the commit because Expo prebuild rewrites them to
expo run:ios and expo run:android; otherwise the dirty worktree blocks removal.
On npm or network failure, report stderr and stop.

From the base folder, add the tour worktree and run:

  git worktree add -B stim-tutorial/tour "{tour}" HEAD
  cd "{tour}"
  stim worktree warm
  stim guide agent

Apply the guide agent doctor rule before native work: if its STATUS block
says doctor is due, run stim doctor --platform ios from the tour worktree and
resolve its findings. No STATUS block means doctor is current. Then run:

  stim start
  stim ios

Tell the user the first build can take about four minutes on a cold cache.
Relay the Open in Stim Desktop link printed by stim ios once.

PAUSE: end the turn. Ask the user to look at the Build section, then the
device, then Logs in Stim Desktop. Without Desktop, use stim status,
stim stats, and stim logs --errors. Give the next prompt:
"${TUTORIAL_PROMPTS.rebuild}". Leave the workspace running.`,
    },
    app: {
      summary: 'Pinned template, verbatim app files, and .gitignore additions',
      body: () => `TUTORIAL APP

create-expo-app: ${TUTORIAL_PINS.createExpoApp}
Template: ${TUTORIAL_PINS.template}
Write the app files verbatim. Append the .gitignore lines to the template's
existing file. App log lines start with [stim:tutorial]. Crash me raises an
uncaught JavaScript error, and Slow request times a local three-second timer;
Stim does not capture native network requests.

${Object.entries(TUTORIAL_FILES)
  .map(
    ([name, content]) =>
      `${name}\n\n\`\`\`${name.endsWith('.json') ? 'json' : name.endsWith('.js') ? 'js' : 'text'}\n${content}\`\`\``,
  )
  .join('\n\n')}`,
    },
    rebuild: {
      summary: 'Repeat the iOS build and explain the cache result',
      body: () => `REBUILD

${paths}

Run the same build again, never with --no-build-cache:

${commands('rebuild')}

Read this workspace's environments[].lastBuilds.ios.cacheHit from
stim status --json, and the miss reason printed by stim ios. Explain a local or remote hit, or the actual miss
reason when cacheHit is false. A repeat run can miss; report the evidence.

PAUSE: end the turn. Point at the Build section and cache badge, or stim stats.
Ask the user to open the device's live view and tap Log an error; without
Desktop use the simulator. Then inspect Logs or stim logs --errors. Crash me
and Slow request are optional: the former shows a red box, the latter prints
a timing line. Give the next prompt: "${TUTORIAL_PROMPTS.agent}".`,
    },
    agent: {
      summary: 'Record a tap and screenshot, replay it, and inspect agent logs',
      body: () => `AGENT ACTIONS

${paths}

Set {stateDir} to this workspace's agentDevice.stateDir from stim ios or
stim status --json. Replace <ios.udid> with this workspace's ios.udid from
stim status --json. Use that exact owned simulator, not a guessed one.
Run from the tour worktree:

${commands('agent').replace('read -r iosUdid', 'iosUdid="<ios.udid>"')}

Use --save-script=tutorial.ad with the equals sign: agent-device treats a
separate path as a URL and refuses. The dismiss-overlay step clears a red box that would cover the buttons.
Remove the target-v1 evidence and dismiss-overlay lines before replay: replaying
them can fail with REPLAY_DIVERGENCE on the recorded button identity.
The scripts and screenshot stay in the tour worktree and are git-ignored.

PAUSE: end the turn. Point at Agent actions, or the agent log records just
printed. Expect another error-button line after replay. When screen recording
is enabled, the user can scrub Replay in Desktop. Give the next prompt:
"${TUTORIAL_PROMPTS.refresh}".`,
    },
    refresh: {
      summary: 'Change the title to purple and verify Fast Refresh through logs',
      body: () => `FAST REFRESH

${paths}

Set TITLE_COLOR in theme.js to '#7c3aed' (purple). Wait a few seconds for
Fast Refresh, without reloading the app:

${commands('refresh')}

The line [stim:tutorial] title color=#7c3aed is the proof that the edit reached
the app. The intentional button errors may still be in the error log; check
whether the edit introduced a new error.

PAUSE: end the turn. Point at the purple title in the device view or simulator
and the title color log line. Phone viewing and an approved build machine are
optional user steps; skip them if unwanted. Never pair, approve, or grant
anything. If the user names an approved machine, the next prompt is
"${TUTORIAL_PROMPTS.machine}". Otherwise give
"${TUTORIAL_PROMPTS.finish}".`,
    },
    machine: {
      summary: 'Optionally build using a machine the user names and has approved',
      body: () => `BUILD MACHINE (OPTIONAL)

${paths}

Proceed only when the user names an approved build machine. Substitute that
name for {machine}. Never approve, pair, or grant anything. If none is named,
ask for the name or let the user skip this step.

${commands('machine')}

This step bypasses the artifact cache so the build can use the named machine.
A named machine refuses without a local fallback. If it refuses, report the
refusal and offer --build-machine auto or local; do not retry silently.

PAUSE: end the turn. Point at the build's machine in Desktop or its report in
stim status --json. Give the next prompt: "${TUTORIAL_PROMPTS.finish}".`,
    },
    finish: {
      summary: 'Revert the tutorial edit, stop, and remove only the tour worktree',
      body: () => `FINISH

${paths}

The user's finish request authorizes removing this tour worktree only.
Revert the refresh edit before removal; worktree remove refuses dirty trees.
Stop from the tour path, then remove from the base checkout:

${commands('finish')}

Never use --force. On a refusal, report it and stop. Keep the base folder
and branch. Print these optional cleanup commands for the user; do not run. Deleting
the base folder also removes the branch, so they are alternatives:

  rm -rf "{base}"
  git -C "{base}" branch -D stim-tutorial/tour

If archive is enabled, tell the user the tour appears under Archived in Stim
Desktop. With archive disabled, report removal without promising an archive.
Without Desktop, inspect stim status --json for the removed environment and,
when enabled, its archived entry. End the turn.`,
    },
    restart: {
      summary: 'Remove the existing tour safely and repeat from the worktree step',
      body: () => `RESTART

${paths}

For "${TUTORIAL_RESTART_PROMPT}", if the tour worktree is present, revert
the refresh edit, stop, and remove it using the finish section's commands:

${commands('finish')}

Never use --force. On a refusal, report it and stop. Keep the base repository.
Read stim guide tutorial run, recheck its folder and repository safety rules,
and redo run from the worktree step. Pause after the build as run instructs.`,
    },
    manual: {
      summary: 'Commands for every step, including heredocs for the app files',
      body: () => `MANUAL TUTORIAL

${paths}

These commands are for a person typing them, one step at a time,
as scripts: save a block to a file and run it with sh -e, so it stops on the
first failure. Read stderr and do not continue to later commands. Follow stim guide tutorial run for folder and repository
safety. Reuse only this version's tutorial app, never overwrite another folder.
The creation block skips writes on reuse and checks the repository root.

Replace {base} and {tour} with absolute paths; {base} must end in stim-tutorial. For Agent actions, replace
{stateDir} with agentDevice.stateDir from stim ios or stim status --json;
when read -r iosUdid waits, type this workspace's ios.udid from that status.
For the optional machine step,
replace {machine} with a machine you have already approved, or skip it.

Look at the sidebar during warm and Build during the first build (about four
minutes on a cold cache). Compare cacheHit and missReason on rebuild. At Live
view and control, open the device viewer and tap Log an error; without Desktop
use the simulator. At App logs, try Crash me or Slow request if wanted. A JS
crash shows a red box; the slow request is a local timer, not network capture.
At Watch on your phone, optionally open an already paired Stim phone to see
the tour workspace; phone setup and machine approval stay with you.
Use stim status, stim logs --errors, and stim stats without Desktop.

${TUTORIAL_STEPS.map((step) => `${step.title}${step.optional ? ' (optional)' : ''}\n\n${step.manual.length ? `\`\`\`sh\n${step.manual.join('\n')}\n\`\`\`` : 'Observe this step in Stim Desktop, or skip it without Desktop.'}`).join('\n\n')}

Finish removes only the tour worktree. Never use --force; report a refusal.
With archive enabled, find the tour under Archived in Desktop or archived[]
in stim status --json. Keep the base repository and branch. To delete them,
read stim guide tutorial finish for commands to review and run yourself.`,
    },
  },
};

export default tutorial;
