import AppKit
import StimKit
import SwiftUI

struct PhoneSetupStep: View {
  var state: SetupStepState
  @ObservedObject private var server = ServerController.shared
  @AppStorage(AppPreferences.Key.servesPhones) private var servesPhones = false
  @State private var pairing = false

  private var canPair: Bool {
    guard case .running(let health, _) = server.state else { return false }
    return health.tailscale.isRunning && health.route?.state == "routed"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Pair your phone (optional)").font(.stim(.title)).accessibilityAddTraits(.isHeader)
      Text(
        "Stim Mobile shows this Mac's workspaces, devices and logs over Tailscale. It is read-only unless you allow control."
      )
      .foregroundStyle(Palette.secondary)
      Toggle("Serve to phones", isOn: $servesPhones)
        .onChange(of: servesPhones) { _, on in on ? server.start() : server.stop() }
      if state == .blocked {
        Label("Tailscale is not running on this Mac", systemImage: "xmark.circle.fill")
          .foregroundStyle(Palette.warning)
        HStack(spacing: Space.md) {
          Text("Run:")
          CommandText(command: "tailscale up")
          Button("Copy") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("tailscale up", forType: .string)
          }
          .buttonStyle(.stim())
        }
        Button("Check again") { server.refresh() }.buttonStyle(.stim())
      } else {
        connection
        if state == .done {
          Label("Phone paired", systemImage: "checkmark.circle.fill").foregroundStyle(Palette.success)
        }
        if let error = server.devicesError {
          Text(abbreviatingHome(error)).foregroundStyle(Palette.error).textSelection(.enabled)
        }
        Button("Pair a Phone\u{2026}") { pairing = true }
          .buttonStyle(.stim(.primary))
          .disabled(!canPair)
          .help(canPair ? "" : "Needs Serve to phones on, Tailscale running and a route.")
      }
    }
    .task {
      while !Task.isCancelled {
        server.refresh()
        try? await Task.sleep(for: .seconds(5))
      }
    }
    .sheet(isPresented: $pairing, onDismiss: server.reloadDevices) {
      PairSheet(server: server)
    }
    .onQuitRequested { pairing = false }
  }

  @ViewBuilder private var connection: some View {
    switch server.state {
    case .off:
      Text("Turn on Serve to phones to pair a phone.").foregroundStyle(Palette.secondary)
    case .starting, .notReady(.pending, _):
      HStack(spacing: Space.md) {
        ProgressView().controlSize(.small)
        Text("Starting stim-server").foregroundStyle(Palette.secondary)
      }
    case .notReady(.degraded(let reason), _):
      Text(abbreviatingHome(reason)).foregroundStyle(Palette.warning).textSelection(.enabled)
    case .failed(let message):
      Text(abbreviatingHome(message)).foregroundStyle(Palette.error).textSelection(.enabled)
      Button("Try Again") { server.start() }.buttonStyle(.stim())
    case .running(let health, _):
      if health.tailscale.isRunning {
        Label("Tailscale running", systemImage: "checkmark.circle.fill").foregroundStyle(Palette.success)
      }
      if let route = health.route, let dnsName = health.tailscale.dnsName {
        RouteSection(server: server, route: route, dnsName: dnsName)
      } else if health.tailscale.isRunning {
        Text("Waiting for the Tailscale route to be reported.").foregroundStyle(Palette.secondary)
      }
    }
  }
}
