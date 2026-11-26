---
title: 'Getting started'
sidebar_position: 2
description: 'Install Stim and the agent skill, then ask your agent to run the app'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';
import PromptBox, { PromptGrid } from '@site/src/components/PromptBox';

Install Stim and its agent skill, then ask your coding agent to run the app.
The agent does the rest. Check the [requirements](./requirements.md) first.

## Install Stim

<StimInstallTabs />

If you installed `stim-cli` globally before, run `npm uninstall --global stim-cli`
first.

Then install the skill for your coding agent:

```bash
npx skills add appandflow/stim
```

The skill is small. It tells the agent to run `stim guide agent`, which prints
instructions for the installed version, so upgrading Stim does not need a new
skill. In a script or without a terminal, add `--yes`.

## Ask the agent to run the app

<PromptBox
title="Build and run"
response={'Trailhead launched on stim-trailhead (iPhone 17 / iOS 26.5).\ncom.appandflow.trailhead · ready · cache hit · 58.8s · errors clean'}

>

{`Run the app on iOS.`}
</PromptBox>

You do not need to say "use Stim". Say it only to override a project wrapper or
another tool.

Behind that prompt, the agent runs something like:

<StimTabs
code={`stim worktree add -b <branch> <path> HEAD  # a worktree with dependencies and build output from the main checkout
cd <path>
stim ios              # build or restore, install, launch, verify
stim logs --errors    # check the captured logs
stim stop             # stop the dev server and device
stim worktree remove  # once the work is merged or abandoned`}
/>

Stim works with Expo and React Native Community CLI projects. It needs no init
step and writes no runtime state into your repository.

## Take the tutorial

Clone a small Expo app and watch two agents make two changes at once, each in
its own worktree with its own simulator and dev server. The first build is cold;
the second reuses it.

<PromptBox
title="Run the Stim tutorial"
response={`The test app is cloned and its dependencies are installed.
Next, ask for a change in your own words.`}

>

{`Clone appandflow/stim-tutorial into ~/stim-tutorial and follow stim guide tutorial run.`}
</PromptBox>

Finishing removes only the two experiment worktrees. An optional last step
deletes the clone.

## Common prompts

<PromptGrid>
  <PromptBox
    title="Choose an iOS simulator"
response={`Trailhead launched on stim-trailhead (iPhone 17 / iOS 26.5).
com.appandflow.trailhead · ready · cache hit · 58.8s · errors clean`}
  >
    {`Run the app on an iPhone 17 simulator with iOS 26.5.`}
  </PromptBox>
  <PromptBox
    title="Run on Android"
    response={`Trailhead launched on stim-trailhead (Pixel 9 / API 36).
com.appandflow.trailhead · ready · cache hit · errors clean`}
  >
    {`Run the app on an Android emulator.`}
  </PromptBox>
  <PromptBox
    title="Use an EAS build"
    response={`Trailhead launched on stim-trailhead (iPhone 17 / iOS 26.5).
com.appandflow.trailhead · ready · EAS build · errors clean`}
  >
    {`Run the app on an iOS simulator using an EAS build.`}
  </PromptBox>
  <PromptBox
    title="Run on a connected phone"
    response={`Trailhead launched on the connected iPhone.
com.appandflow.trailhead · ready · device lease released · errors clean`}
  >
    {`Run the app on my connected iPhone.`}
  </PromptBox>
  <PromptBox title="Inspect recent errors" response={`No Trailhead app errors in the last 10 minutes.`}>
    {`Show app errors from the last 10 minutes.`}
  </PromptBox>
  <PromptBox
    title="Check the environment"
    response={`Trailhead is active on stim-trailhead (iPhone 17 / iOS 26.5).
com.appandflow.trailhead · Metro 8083 · launch ready`}
  >
    {`What is running for this workspace?`}
  </PromptBox>
  <PromptBox
    title="Stop the environment"
    response={`Stopped Trailhead: Metro on port 8083 stopped, stim-trailhead (iPhone 17 / iOS 26.5) shut down.
The simulator stays assigned for the next run.`}
  >
    {`I'm done testing for now. Stop this workspace's dev server and simulator.`}
  </PromptBox>
  <PromptBox
    title="Review build performance"
    response={`iOS · 3 runs · 67% cache hits · cached average 46s · estimated savings ~7m`}
  >
    {`Show iOS build performance.`}
  </PromptBox>
  <PromptBox
    title="Work in parallel"
    response={`Implemented on feature/settings-toggle in an isolated worktree.
Trailhead · iPhone 17 / iOS 26.5 · ready · cache hit · errors clean
Branch preserved.`}
  >
    {`Make this change in a separate worktree and validate it on iOS.`}
  </PromptBox>
  <PromptBox
    title="Record PR validation"
    response={`Validated the Trailhead Settings flow on iPhone 17 / iOS 26.5.
Before and After recordings captured; named assertion passed; PR opened with the comparison table.`}
  >
    {`Fix this in a separate worktree. Record the affected flow before and after on iOS with agent-device, then open a PR with the recordings in a Before/After table.`}
  </PromptBox>
</PromptGrid>

## What to expect

- The agent works in a separate git worktree unless you ask for the current
  checkout, or the task needs your uncommitted changes there.
- Each workspace (one app in one checkout) gets its own Metro port and its own
  simulator or emulator. Stim only boots or deletes devices it created.
- Builds are cached across worktrees, so a second worktree usually installs in
  seconds instead of compiling. See [build caches](./build-caches.md).
- A run ends with a short summary: device, app, cache result, launch state and
  log path. `launch UNVERIFIED` means the agent must follow the printed remedy
  before it claims success. None of this proves the screen looks right; ask for
  a screenshot when that matters.
- `stim stop` shuts the device down but keeps it; an owned iOS simulator can
  stay booted for a grace period while memory allows. `stim worktree remove`
  reclaims everything the worktree owns. `stim gc --dry-run` shows what is
  left over from workspaces that are gone.

## When it fails

The agent handles most refusals itself: each one prints a code such as
`STIM_METRO_TIMEOUT` and a remedy. If you are looking yourself, run
`stim doctor` and `stim logs --errors`, or search the code on the
[troubleshooting page](./troubleshooting.md).

## Report a problem

When Stim gets in the way, the agent offers to file an issue on
[appandflow/stim](https://github.com/appandflow/stim/issues). It searches for an
existing issue first, removes secrets, private paths and project code, and
shows you the draft before filing. To ask for it yourself:

<PromptBox title="Report a Stim problem" response={`Found no matching issue. Draft ready: command, STIM_* code, output, versions, workaround. File it?`}>
{`Stim got in my way just now. Search the appandflow/stim issues for it, then draft an issue (or a comment on the matching one) with the command, error code, output, versions and workaround, without secrets or private paths. Show me the draft before filing anything.`}
</PromptBox>

## Clean up when a session ends

An agent that ends without `stim stop` leaves a dev server and a device running.
In Claude Code, a `SessionEnd` hook stops the workspace the session ran in:

```json title="settings.json"
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c);process.stdin.on(\"end\",()=>require(\"child_process\").spawnSync(\"npx\",[\"stim\",\"stop\"],{cwd:JSON.parse(d).cwd,stdio:\"inherit\"}))'"
          }
        ]
      }
    ]
  }
}
```

Codex CLI has no session-end hook yet
([openai/codex#20374](https://github.com/openai/codex/issues/20374)).

## Next steps

- [Stim Desktop](./desktop.md) shows every workspace, device and log on your Mac.
- [Remote machines](./remote-machines.md) build or run on another approved machine.
- The [phone app](./phone-app.md) watches workspaces away from your desk.
- `stim guide` prints the full reference for the installed version.
