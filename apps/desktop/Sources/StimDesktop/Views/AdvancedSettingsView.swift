import AppKit
import StimKit
import SwiftUI

struct AdvancedSettingsView: View {
  @ObservedObject private var flags = FeatureFlagStore.shared
  @ObservedObject var server: ServerController
  var settings: MachineSettingsStore
  let stimHome: String
  @AppStorage(AppPreferences.Key.stimServerExecutable) private var executable = ""
  @AppStorage(AppPreferences.Key.stimHome) private var homeSetting = ""
  @AppStorage(AppPreferences.Key.environmentOverrides) private var overrides = ""

  var body: some View {
    Form {
      Section {
        ForEach(FeatureFlag.allCases) { flag in
          VStack(alignment: .leading, spacing: Space.xs) {
            Toggle(
              flag.title,
              isOn: Binding(get: { flags.isEnabled(flag) }, set: { flags.set(flag, enabled: $0) }))
            Text(flag.summary)
              .font(.stim(.footnote))
              .foregroundStyle(Palette.tertiary)
              .multilineTextAlignment(.leading)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(.vertical, Space.xs)
        }
        HStack {
          Spacer()
          Button("Reset to Defaults", action: flags.reset)
            .buttonStyle(.stim())
            .disabled(!flags.hasOverrides)
        }
      } header: {
        Text("Feature Flags")
      } footer: {
        Text("Flags are stored on this Mac only.").foregroundStyle(Palette.tertiary)
      }
      RecordingSection(settings: settings)
      Section {
        TextField("Stim home", text: $homeSetting, prompt: Text("~/.stim"))
        VStack(alignment: .leading, spacing: Space.xs) {
          Text("Environment")
          TextEditor(text: $overrides)
            .font(.stim(.callout, mono: true))
            .frame(minHeight: 72)
        }
      } header: {
        Text("Environment")
      } footer: {
        Text(
          "Stim Desktop runs no login shell: Stim finds Node, Homebrew, the Android SDK and Java itself. Set the Stim home here instead of STIM_HOME, and add other variables, such as STIM_* settings, as KEY=VALUE lines. Changes apply when Stim Desktop restarts."
        )
        .foregroundStyle(Palette.tertiary)
      }
      Section {
        ServerStatusRows(server: server, stimHome: stimHome)
        HStack {
          TextField("stim-server executable", text: $executable, prompt: Text("the stim-server bundled with Stim Desktop"))
          Button("Choose\u{2026}", action: chooseExecutable).buttonStyle(.stim())
        }
        .help("Overrides the bundled stim-server the next time the server starts.")
      } header: {
        Text("stim-server")
      } footer: {
        Text(
          "Stim Desktop runs stim-server while it is open, on this Mac only, for device replay, the diff viewer, archived logs and hosted views. It uses one that already serves this Stim home."
        )
        .foregroundStyle(Palette.tertiary)
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Palette.background)
  }

  private func chooseExecutable() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.prompt = "Choose"
    if panel.runModal() == .OK, let url = panel.url { executable = url.path }
  }
}
