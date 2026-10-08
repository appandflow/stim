import StimKit
import SwiftUI

/// `recording.enabled` in the machine layer: whether stim-server records device screens on this Mac for replay.
struct RecordingSection: View {
  var settings: MachineSettingsStore
  @State private var writing = false
  @State private var writeFailure: String?
  @State private var confirmingOff = false

  private var entry: SettingEntry? { settings.entry("recording.enabled") }

  private var failure: String? {
    writeFailure ?? settings.error
      ?? (settings.payload != nil && entry == nil
        ? "This stim has no recording.enabled setting; update it to replay devices." : nil)
  }

  private var enabled: Bool { entry?.layer(.machine)?.bool ?? true }

  var body: some View {
    Section {
      Toggle(
        "Record device screens for replay",
        isOn: Binding(
          get: { enabled },
          set: { on in
            if on {
              write(true)
            } else {
              confirmingOff = true
            }
          })
      )
      .disabled(entry == nil || writing || entry?.env != nil)
      if let override = entry?.env {
        Text("\(override.name)=\(override.value) overrides this setting.").foregroundStyle(Palette.warning)
      }
      if let failure {
        Text(failure).foregroundStyle(Palette.error)
      }
    } footer: {
      Text(PhoneApp.Copy.recordingFooter(phoneApp: FeatureFlags.isEnabled(.phoneApp)))
        .foregroundStyle(Palette.tertiary)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .task { await settings.refresh() }
    .confirmationDialog("Stop recording device screens?", isPresented: $confirmingOff, titleVisibility: .visible) {
      Button("Turn off and delete recordings", role: .destructive) { write(false) }
    } message: {
      Text("stim settings set recording.enabled false --scope machine deletes the recordings of every workspace it turns off.")
    }
  }

  private func write(_ on: Bool) {
    writing = true
    Task {
      let result = await settings.write(
        "recording.enabled", value: on ? "true" : "false", scope: .machine, cwd: NSHomeDirectory())
      switch result {
      case .success(.written): writeFailure = nil
      case .success(.refused(let refusal)):
        writeFailure = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
      case .failure(let error): writeFailure = error.localizedDescription
      }
      writing = false
    }
  }
}
