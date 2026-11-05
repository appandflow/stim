import AppKit
import StimKit
import SwiftUI

struct PhoneSetupStep: View {
  var state: SetupStepState
  @ObservedObject private var server = ServerController.shared
  @AppStorage("settingsTab") private var settingsTab = "app"
  @Environment(\.openSettings) private var openSettings
  @State private var pairing = false
  @State private var pairingModel: PairPhoneModel?

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Pair Your Phone (Optional)").font(.stim(.title)).accessibilityAddTraits(.isHeader)
      Text(
        "Stim Mobile shows this Mac's workspaces, devices and logs over Tailscale. It is read-only unless you allow control."
      )
      .foregroundStyle(Palette.secondary)
      if state == .done {
        Label("Phone paired", systemImage: "checkmark.circle.fill").foregroundStyle(Palette.success)
      }
      Button("Pair a Phone\u{2026}") {
        pairingModel = PairPhoneModel(stimHome: StimHome.path(environment: ProcessInfo.processInfo.environment))
        pairing = true
      }.buttonStyle(.stim(.primary))
    }
    .task {
      while !Task.isCancelled {
        server.refresh()
        try? await Task.sleep(for: .seconds(5))
      }
    }
    .sheet(isPresented: $pairing, onDismiss: server.reloadDevices) {
      if let pairingModel {
        PairPhoneSheet(model: pairingModel) {
          settingsTab = "phones"
          openSettings()
        }
      }
    }
    .onQuitRequested { pairing = false }
  }
}
