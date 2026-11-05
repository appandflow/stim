import StimKit
import SwiftUI

struct MaintenanceSection: View {
  var maintenance: MaintenanceStatus?
  var daemon: DaemonStatus?
  var statusLoaded: Bool
  var settings: MachineSettingsStore
  @State private var writing: String?
  @State private var writeFailure: String?

  var body: some View {
    Section {
      LabeledContent("Mode") {
        Text(modeTitle).foregroundStyle(daemon?.mode == "on" && maintenance?.invalid == nil ? Palette.text : Palette.warning)
      }
      if let daemon {
        LabeledContent("Pressure") {
          Text(daemon.headline).foregroundStyle(daemon.isRaised ? Palette.warning : Palette.secondary)
        }
        ForEach(daemon.lastActions()) { action in
          LabeledContent {
            if let date = action.date {
              Text(date, style: .relative).foregroundStyle(Palette.tertiary)
            }
          } label: {
            Text(action.title + (action.bytes > 0 ? ", \(Format.fileSize(action.bytes))" : ""))
              .help(action.detail)
          }
        }
      }
      if let maintenance {
        LabeledContent("Last pass") { Text(lastPass(maintenance)).foregroundStyle(Palette.secondary) }
        ForEach(maintenance.lastPass?.blocked ?? [], id: \.self) { reason in
          Text(reason).font(.stim(.footnote)).foregroundStyle(Palette.warning)
        }
      }
      picker(
        "Clean up what is unused for", key: "maintenance.olderThanDays", choices: AppPreferences.olderThanDayChoices
      ) { days in days == 0 ? "Never" : days == 1 ? "1 day" : "\(days) days" }
      picker(
        "Stop idle workspaces after", key: "idle.minutes",
        choices: AppPreferences.idleShutdownMinuteChoices
      ) { minutes in minutes == 0 ? "Never" : minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes) min" }
      toggle("Also remove clean, pushed worktrees unused that long", key: "maintenance.removeIdleWorktrees")
      if let failure = writeFailure ?? settings.error {
        Text(failure).foregroundStyle(Palette.error)
      }
    } header: {
      Text("Automatic Maintenance")
    } footer: {
      Text(
        "With daemon.mode on, the stim-daemon stops a workspace with no activity for that long: its dev server, its owned simulators and emulators, and its regenerable build outputs, which stim revive brings back. After idle.dormantDays it deletes the workspace's owned devices. Under disk or memory pressure it reclaims idle workspaces, parked devices and shared caches first, and never touches a workspace in use. Once a day it clears the build outputs and cache entries unused for the cleanup age and deletes devices parked that long. Removing idle worktrees whose branch is not merged is off by default and also needs worktree removal on and a cleanup age other than Never: it takes their git-ignored files, such as .env.local. These are machine settings, written with stim settings set, which a project's own setting overrides. Every setting is under Stim Settings."
      )
      .multilineTextAlignment(.leading)
      .frame(maxWidth: .infinity, alignment: .leading)
      .foregroundStyle(Palette.tertiary)
    }
    .task { await settings.refresh() }
  }

  private var modeTitle: String {
    guard let daemon else {
      return statusLoaded ? "Not reported: update stim to run the stim-daemon" : "Unknown until stim status loads"
    }
    if let invalid = maintenance?.invalid { return "Off: \(invalid)" }
    if maintenance?.claim != nil { return "Blocked by an unresolved claim; see stim status" }
    let running = daemon.running == nil ? ", not running now" : ""
    switch daemon.mode {
    case "on": return "On\(running)"
    case "report": return "Report only: logs what it would do, deletes nothing\(running)"
    default: return "Off: nothing reclaims on its own"
    }
  }

  private func lastPass(_ maintenance: MaintenanceStatus) -> String {
    guard let pass = maintenance.lastPass else { return "None yet" }
    let when = pass.date.formatted(date: .abbreviated, time: .shortened)
    if pass.mode != "on" { return "\(when): \(pass.actions == 1 ? "1 planned action" : "\(pass.actions) planned actions")" }
    let actions = pass.actions == 1 ? "1 action" : "\(pass.actions) actions"
    return "\(when): \(actions), \(Format.fileSize(pass.freedBytes)) freed"
  }

  private func picker(_ title: String, key: String, choices: [Int], label: @escaping (Int) -> String) -> some View {
    let entry = settings.entry(key)
    let current = entry?.number.map { Int($0) }
    let options = current.map { choices.contains($0) ? choices : (choices + [$0]).sorted() } ?? choices
    return VStack(alignment: .leading, spacing: 4) {
      Picker(
        title,
        selection: Binding(
          get: { current ?? -1 },
          set: { value in write(key, text: String(value)) })
      ) {
        if current == nil { Text("Unknown").tag(-1) }
        ForEach(options, id: \.self) { Text(label($0)).tag($0) }
      }
      .disabled(entry == nil || writing != nil || entry?.env != nil)
      if let override = entry?.env {
        Text("\(override.name)=\(override.value) overrides this setting.").foregroundStyle(Palette.warning)
      } else if settings.payload != nil, entry == nil {
        Text("This stim has no \(key) setting; update stim to a version newer than 1.25.0.").foregroundStyle(Palette.warning)
      }
    }
  }

  private func toggle(_ title: String, key: String) -> some View {
    let entry = settings.entry(key)
    return VStack(alignment: .leading, spacing: 4) {
      Toggle(
        title,
        isOn: Binding(
          get: { entry?.value.bool ?? false },
          set: { on in write(key, text: on ? "true" : "false") })
      )
      .disabled(entry == nil || writing != nil || entry?.env != nil)
      if let override = entry?.env {
        Text("\(override.name)=\(override.value) overrides this setting.").foregroundStyle(Palette.warning)
      } else if settings.payload != nil, entry == nil {
        Text("This stim has no \(key) setting; update stim to a version newer than 1.25.0.").foregroundStyle(Palette.warning)
      }
    }
  }

  private func write(_ key: String, text: String) {
    writing = key
    Task {
      switch await settings.write(key, value: text, scope: .machine, cwd: NSHomeDirectory()) {
      case .success(.written): writeFailure = nil
      case .success(.refused(let refusal)):
        writeFailure = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
      case .failure(let error): writeFailure = error.localizedDescription
      }
      writing = nil
    }
  }
}
