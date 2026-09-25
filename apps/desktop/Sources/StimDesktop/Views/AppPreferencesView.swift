import AppKit
import ServiceManagement
import StimKit
import SwiftUI

struct AppPreferencesView: View {
  @AppStorage(AppPreferences.Key.appearance) private var appearance = Appearance.auto
  @AppStorage(AppPreferences.Key.showsIdleWorkspaces) private var showsIdle = true
  @AppStorage(AppPreferences.Key.defaultView) private var defaultView = DefaultView.allDevices
  @AppStorage(AppPreferences.Key.tileSize) private var tileSize = TileSize.medium
  @AppStorage(AppPreferences.Key.maxFramesPerSecond) private var framesPerSecond = 60.0
  @AppStorage(AppPreferences.Key.pausesHiddenFrames) private var pausesHidden = true
  @AppStorage(AppPreferences.Key.editorBundleID) private var editor = ""
  @AppStorage(AppPreferences.Key.terminalBundleID) private var terminal = ""
  @AppStorage(AppPreferences.Key.showsMenuBarExtra) private var showsMenuBarExtra = false
  @AppStorage(AppPreferences.Key.stimExecutable) private var stimExecutable = ""
  @AppStorage(AppPreferences.Key.remoteSessionMinutes) private var remoteMinutes = 30
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
        Toggle("Show idle workspaces", isOn: $showsIdle)
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

      Section("Notifications") {
        if !Notifier.isAvailable {
          Text("Notifications need the bundled app; `swift run` cannot post them.")
            .foregroundStyle(Theme.tertiary)
        }
        ForEach(StatusEvent.Kind.allCases, id: \.self) { kind in
          NotificationToggle(kind: kind)
        }
        Stepper("Remote session reminder after \(remoteMinutes) min", value: $remoteMinutes, in: 5...240, step: 5)
      }

      Section("System") {
        Toggle("Show in the menu bar", isOn: $showsMenuBarExtra)
        Toggle("Launch at login", isOn: $launchesAtLogin)
          .onChange(of: launchesAtLogin) { _, enabled in setLaunchAtLogin(enabled) }
        if let loginError {
          Text(loginError).foregroundStyle(Theme.error)
        }
      }

      Section("Stim executable") {
        HStack {
          TextField("stim on the login shell's PATH", text: $stimExecutable)
          Button("Choose\u{2026}", action: chooseExecutable)
        }
        Text("Overrides STIM_BIN and PATH. Takes effect the next time Stim Desktop starts.")
          .foregroundStyle(Theme.tertiary)
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Theme.background)
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
