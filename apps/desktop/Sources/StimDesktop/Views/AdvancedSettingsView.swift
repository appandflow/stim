import AppKit
import StimKit
import SwiftUI

struct AdvancedSettingsView: View {
  @ObservedObject private var flags = FeatureFlagStore.shared
  @ObservedObject var server: ServerController
  var settings: MachineSettingsStore
  let stimHome: String
  @AppStorage(AppPreferences.Key.stimServerExecutable) private var executable = ""

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
        Text("Feature flags")
      } footer: {
        Text("Flags are stored on this Mac only.").foregroundStyle(Palette.tertiary)
      }
      RecordingSection(settings: settings)
      Section {
        ServerStatusRows(server: server, stimHome: stimHome)
        HStack {
          TextField("stim-server executable", text: $executable, prompt: Text("stim-server on the login shell's PATH"))
          Button("Choose\u{2026}", action: chooseExecutable).buttonStyle(.stim())
        }
        .help("Overrides PATH the next time the server starts.")
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
