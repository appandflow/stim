import AppKit
import ServiceManagement
import StimKit
import SwiftUI

struct AppPreferencesView: View {
  @AppStorage(AppPreferences.Key.appearance) private var appearance = Appearance.auto
  @AppStorage(AppPreferences.Key.sidebarStatus) private var status = StatusFilter.all
  @AppStorage(AppPreferences.Key.defaultView) private var defaultView = DefaultView.allDevices
  @AppStorage(AppPreferences.Key.tileSize) private var tileSize = TileSize.medium
  @AppStorage(AppPreferences.Key.maxFramesPerSecond) private var framesPerSecond = 60.0
  @AppStorage(AppPreferences.Key.pausesHiddenFrames) private var pausesHidden = true
  @AppStorage(AppPreferences.Key.editorBundleID) private var editor = ""
  @AppStorage(AppPreferences.Key.terminalBundleID) private var terminal = ""
  @AppStorage(AppPreferences.Key.showsMenuBarExtra) private var showsMenuBarExtra = false
  @AppStorage(AppPreferences.Key.stimExecutable) private var stimExecutable = ""
  @AppStorage(AppPreferences.Key.remoteSessionMinutes) private var remoteMinutes = 30
  @AppStorage(AppPreferences.Key.autopilotIdleShutdown) private var idleShutdown = true
  @AppStorage(AppPreferences.Key.autopilotIdleMinutes) private var idleMinutes = 60
  @AppStorage(AppPreferences.Key.autopilotNightly) private var nightly = true
  @AppStorage(AppPreferences.Key.autopilotNightlyHour) private var nightlyHour = 3
  @AppStorage(AppPreferences.Key.autopilotNightlyOlderThanDays) private var nightlyOlderThanDays = 7
  @AppStorage(AppPreferences.Key.autopilotPressure) private var actsOnPressure = true
  @AppStorage(AppPreferences.Key.notifiesDiskPressure) private var notifiesPressure = true
  @AppStorage(AppPreferences.Key.autopilotPullRequests) private var removesFinishedWorktrees = true
  @AppStorage(AppPreferences.Key.notifiesWorktreeRemoval) private var notifiesWorktreeRemoval = true
  @EnvironmentObject private var autopilot: AutopilotRunner
  @ObservedObject private var updater = AppUpdater.shared
  @State private var launchesAtLogin = SMAppService.mainApp.status == .enabled
  @State private var loginError: String?

  var body: some View {
    Form {
      Section("Appearance") {
        Picker("Appearance", selection: $appearance) {
          ForEach(Appearance.allCases, id: \.self) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        .onChange(of: appearance) { _, value in Theme.apply(value) }
      }

      Section("Workspace list") {
        Picker("Status", selection: $status) {
          ForEach(StatusFilter.allCases, id: \.self) { Text($0.title).tag($0) }
        }
        Picker("Open to", selection: $defaultView) {
          ForEach(DefaultView.allCases, id: \.self) { Text($0.title).tag($0) }
        }
      }

      Section("Device wall") {
        Picker("Tile size", selection: $tileSize) {
          ForEach(TileSize.allCases, id: \.self) { Text($0.title).tag($0) }
        }
        Picker("Live frame rate", selection: $framesPerSecond) {
          ForEach(AppPreferences.frameRates, id: \.self) { Text("\(Int($0)) fps").tag($0) }
        }
        Toggle("Pause frames while the window is hidden", isOn: $pausesHidden)
      }

      Section("Integrations") {
        appPicker("Open in editor", selection: $editor, apps: ExternalApp.editors)
        appPicker("Open in Terminal", selection: $terminal, apps: ExternalApp.terminals)
      }

      Section {
        Toggle("Shut down idle devices", isOn: $idleShutdown)
        Picker("After", selection: $idleMinutes) {
          ForEach(AppPreferences.idleMinuteChoices, id: \.self) { minutes in
            Text(minutes < 60 ? "\(minutes) min" : "\(minutes / 60) h").tag(minutes)
          }
        }
        .disabled(!idleShutdown)
        Toggle("Clean up every night", isOn: $nightly)
        Picker("At", selection: $nightlyHour) {
          ForEach(0..<24, id: \.self) { hour in Text(String(format: "%02d:00", hour)).tag(hour) }
        }
        .disabled(!nightly)
        Picker("Only what is unused for", selection: $nightlyOlderThanDays) {
          ForEach(AppPreferences.nightlyOlderThanDayChoices, id: \.self) { days in
            Text(days == 1 ? "1 day" : "\(days) days").tag(days)
          }
        }
        .disabled(!nightly)
        Toggle("Reclaim space when free disk is under the Stim budget", isOn: $actsOnPressure)
        Toggle("Remove worktrees whose pull request was merged or closed", isOn: $removesFinishedWorktrees)
        if removesFinishedWorktrees, let problem = autopilot.pullRequestCheck {
          Text(problem).font(.stim(.footnote)).foregroundStyle(Palette.warning)
        }
      } header: {
        Text("Autopilot")
      } footer: {
        Text(
          "Idle shutdown runs stim gc --idle, which shuts owned simulators and emulators down and never deletes them. A device whose screen changed in this app is left running. Nightly cleanup runs stim gc --delete --worktrees --older-than with the chosen days (7 by default): it removes merged worktrees and clean ones idle that long, clears the build outputs of workspaces and the cache entries unused that long, and deletes devices parked or unused that long. Disk pressure runs stim gc --delete with no age limit: it clears the build outputs of every workspace not in use, so their next build installs from the shared cache, removes merged worktrees, and deletes parked and unused owned devices. The budget is budget.minFreeDiskGb. A nightly run the Mac slept through runs at the next check. Finished pull requests: every 5 minutes and when the app becomes active, gh lists each repository's merged and closed pull requests. When a linked worktree's branch is among them, stim gc checks it, and stim worktree remove removes it only when it is clean, has no commit that exists only locally (a merged pull request's own commits excepted), no Metro, build or device of it is live, and 2 hours have passed since the merge or its last activity (gc.worktreeGraceMinutes). A worktree it keeps is listed in Needs attention with the reason."
        )
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(Palette.tertiary)
      }

      Section {
        if autopilot.log.isEmpty {
          Text("No runs yet.").foregroundStyle(Palette.tertiary)
        } else {
          ForEach(autopilot.log.prefix(50)) { entry in AutopilotLogRow(entry: entry) }
        }
      } header: {
        HStack {
          Text("Autopilot activity")
          Spacer()
          if !autopilot.log.isEmpty {
            Button("Clear") { autopilot.clearLog() }.buttonStyle(.stim())
          }
        }
      }

      Section("Notifications") {
        if !Notifier.isAvailable {
          Text("Notifications need the bundled app; `swift run` cannot post them.")
            .foregroundStyle(Palette.tertiary)
        }
        ForEach(StatusEvent.Kind.allCases, id: \.self) { kind in
          NotificationToggle(kind: kind)
        }
        Toggle("Free disk falls under the Stim budget", isOn: $notifiesPressure)
          .disabled(!Notifier.isAvailable)
          .onChange(of: notifiesPressure) { _, on in if on { Notifier.requestAuthorization() } }
        Toggle("Autopilot removes worktrees of finished pull requests", isOn: $notifiesWorktreeRemoval)
          .disabled(!Notifier.isAvailable)
          .onChange(of: notifiesWorktreeRemoval) { _, on in if on { Notifier.requestAuthorization() } }
        Stepper("Remote session reminder after \(remoteMinutes) min", value: $remoteMinutes, in: 5...240, step: 5)
      }

      Section("System") {
        Toggle("Show in the menu bar", isOn: $showsMenuBarExtra)
        Toggle("Launch at login", isOn: $launchesAtLogin)
          .onChange(of: launchesAtLogin) { _, enabled in setLaunchAtLogin(enabled) }
        if let loginError {
          Text(abbreviatingHome(loginError)).foregroundStyle(Palette.error)
        }
      }

      Section {
        Toggle("Automatically check for updates", isOn: $updater.automaticallyChecksForUpdates)
          .disabled(!updater.isAvailable)
      } header: {
        Text("Updates")
      } footer: {
        if !updater.isAvailable {
          Text("This build has no update key, so it never checks for updates.").foregroundStyle(Palette.tertiary)
        }
      }

      Section("Stim executable") {
        HStack {
          TextField("stim on the login shell's PATH", text: $stimExecutable)
          Button("Choose\u{2026}", action: chooseExecutable)
        }
        Text("Overrides STIM_BIN and PATH. Takes effect the next time Stim Desktop starts.")
          .foregroundStyle(Palette.tertiary)
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Palette.background)
  }

  private func appPicker(_ title: String, selection: Binding<String>, apps: [ExternalApp]) -> some View {
    let installed = apps.filter { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0.bundleID) != nil }
    return Picker(title, selection: selection) {
      Text("First installed").tag("")
      ForEach(installed) { Text($0.name).tag($0.bundleID) }
    }
  }

  private func setLaunchAtLogin(_ enabled: Bool) {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      loginError = nil
    } catch {
      loginError = "Could not change the login item: \(error.localizedDescription)"
      launchesAtLogin = SMAppService.mainApp.status == .enabled
    }
  }

  private func chooseExecutable() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.prompt = "Choose"
    if panel.runModal() == .OK, let url = panel.url { stimExecutable = url.path }
  }
}

private struct NotificationToggle: View {
  var kind: StatusEvent.Kind
  @AppStorage private var enabled: Bool

  init(kind: StatusEvent.Kind) {
    self.kind = kind
    _enabled = AppStorage(wrappedValue: false, AppPreferences.Key.notifies(kind))
  }

  var body: some View {
    Toggle(kind.title, isOn: $enabled)
      .disabled(!Notifier.isAvailable)
      .onChange(of: enabled) { _, on in if on { Notifier.requestAuthorization() } }
  }
}

private struct AutopilotLogRow: View {
  var entry: AutopilotLogEntry

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.md) {
      Image(systemName: entry.exitStatus == 0 ? "checkmark.circle.fill" : "xmark.octagon.fill")
        .foregroundStyle(entry.exitStatus == 0 ? Palette.success : Palette.error)
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack {
          Text(entry.trigger.title)
          Spacer()
          Text(entry.date.formatted(date: .abbreviated, time: .shortened)).foregroundStyle(Palette.tertiary)
        }
        Text(abbreviatingHome(entry.command)).font(.stim(.caption, mono: true)).foregroundStyle(Palette.secondary)
        if let note = entry.note {
          Text(abbreviatingHome(note)).font(.stim(.footnote)).foregroundStyle(Palette.tertiary).lineLimit(2)
        }
      }
    }
    .textSelection(.enabled)
  }
}
