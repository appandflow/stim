import StimKit
import SwiftUI

struct AdvancedSettingsView: View {
  @ObservedObject private var flags = FeatureFlagStore.shared

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
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Palette.background)
  }
}
