# Unreleased

## Added

- A `project` plugin kind recognises a project type Stim does not bundle, such as a Godot game, from a plugin's `package.json` alone (`stimPlugin.kinds.project` and a `stimPlugin.project` block with `id`, `name` and `markers`). The new machine setting `plugins` lists plugin directories by absolute path. A folder that holds every marker is a project root: `stim worktree add` and `warm` register it, `stim status` names the type, and `stim ios`, `android`, `macos` and `start` refuse with `STIM_NO_PROJECT` naming it. Stim builds and runs nothing for it and never imports the plugin's code. `stim plugin list`, `stim plugin test`, `stim doctor` and `stim settings set plugins` report a manifest Stim does not accept. The kind is experimental: its contract and integer may change in a minor release. `stim/plugin` exports `PROJECT_API_VERSION`, `ProjectPluginManifest` and `runProjectContract`. [#6599](https://github.com/appandflow/stim/issues/6599)
