import StimKit
import SwiftUI

struct PhonesView: View {
  @ObservedObject var server: ServerController
  let stimHome: String
  @AppStorage(AppPreferences.Key.servesPhones) private var servesPhones = false
  @ObservedObject private var flags = FeatureFlagStore.shared
  @State private var pairing = false
  @State private var pairingModel: PairPhoneModel?
  @State private var revoking: PairedDevice?

  var body: some View {
    Form {
      if let problem {
        Section { problemRow(problem) }
      }
      phones
      Section("Server") {
        Toggle("Serve to phones", isOn: $servesPhones)
        ServerStatusRows(server: server, stimHome: stimHome)
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Palette.background)
    .task {
      while !Task.isCancelled {
        server.refresh()
        try? await Task.sleep(for: .seconds(5))
      }
    }
    .sheet(isPresented: $pairing, onDismiss: server.reloadDevices) {
      if let pairingModel { PairPhoneSheet(model: pairingModel) }
    }
    .onQuitRequested { pairing = false }
    .onReceive(OpenRequests.shared.$pairsPhone) { pairs in
      guard pairs else { return }
      OpenRequests.shared.pairsPhone = false
      guard flags.phoneApp else { return }
      pair()
    }
    .confirmationDialog(
      revoking.map { "Revoke \($0.name)?" } ?? "",
      isPresented: .init(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
      presenting: revoking
    ) { device in
      Button("Revoke", role: .destructive) { server.revoke(device) }
    } message: { _ in
      Text("The phone disconnects and must pair again to reconnect.")
    }
  }

  @ViewBuilder private var phones: some View {
    let errors = serverErrors
    if server.phones.isEmpty {
      Section {
        ForEach(errors, id: \.self) { Text(abbreviatingHome($0)).foregroundStyle(Palette.error) }
        VStack(spacing: Space.lg) {
          ZStack {
            BrandHalo(size: 130)
            BrandBadge(systemImage: "iphone", size: 64)
          }
          .accessibilityHidden(true)
          Text("No paired phones").font(.stim(.headline))
          Text("See this Mac's workspaces, devices and logs on your phone.")
            .foregroundStyle(Palette.secondary)
            .multilineTextAlignment(.center)
          Button("Pair a Phone\u{2026}", action: pair).buttonStyle(.stim(.primary, .regular))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.xl)
      }
    } else {
      Section {
        ForEach(errors, id: \.self) { Text(abbreviatingHome($0)).foregroundStyle(Palette.error) }
        ForEach(server.phones) { device in
          PhoneRow(
            device: device, changing: server.pendingGrants[device.id] != nil,
            allowControl: { server.grant(device, control: $0) }, revoke: { revoking = device })
        }
      } header: {
        HStack {
          Text("Paired phones")
          Spacer()
          Button("Pair a Phone\u{2026}", action: pair).buttonStyle(.stim(.primary))
        }
      }
    }
  }

  private var serverErrors: [String] { [server.devicesError, server.changeError].compactMap { $0 } }

  private func pair(fixing: Bool) {
    pairingModel = PairPhoneModel(stimHome: stimHome, fixing: fixing)
    pairing = true
  }

  private func pair() { pair(fixing: false) }

  private enum Problem {
    case servingOff, tailscaleOff, funneled, noRoute

    var text: String {
      switch self {
      case .servingOff: return "Serving is off, so paired phones can't connect."
      case .tailscaleOff: return "Tailscale is off on this Mac, so phones can't connect."
      case .funneled: return "Tailscale Funnel makes the Stim server public, so phones are refused."
      case .noRoute: return "Phones can't reach this Mac yet: its private tailnet route is not set up."
      }
    }
  }

  private var problem: Problem? {
    guard servesPhones else { return server.phones.isEmpty ? nil : .servingOff }
    guard case .running(let health, _) = server.state else { return nil }
    if !health.tailscale.isRunning { return .tailscaleOff }
    switch health.route?.state {
    case "funneled": return .funneled
    case "missing", "unknown": return .noRoute
    default: return nil
    }
  }

  private func problemRow(_ problem: Problem) -> some View {
    HStack(spacing: Space.md) {
      Label(problem.text, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
      Spacer()
      if problem == .servingOff {
        Button("Turn On") { servesPhones = true }.buttonStyle(.stim())
      } else {
        Button("Fix\u{2026}") { pair(fixing: true) }.buttonStyle(.stim())
      }
    }
  }
}

private struct PhoneRow: View {
  var device: PairedDevice
  var changing: Bool
  var allowControl: (Bool) -> Void
  var revoke: () -> Void

  var body: some View {
    HStack(spacing: Space.lg) {
      Image(systemName: "iphone").iconFont(IconSize.large).foregroundStyle(Palette.accent)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(verbatim: device.name).font(.stim(.body, weight: .semibold)).lineLimit(1)
        Text(lastSeen).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      }
      Spacer()
      Pill(device.canControl ? "Can control" : "View only", tone: device.canControl ? .success : .neutral, size: .small)
      Menu {
        Button(device.canControl ? "View Only" : "Allow Control") { allowControl(!device.canControl) }
          .disabled(changing)
        Divider()
        Button("Revoke\u{2026}", role: .destructive, action: revoke)
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel("More actions for \(device.name)")
    }
    .padding(.vertical, Space.xxs)
  }

  private var lastSeen: String {
    guard let at = device.lastSeenAt else { return "Never seen" }
    return "Seen \(at.formatted(.relative(presentation: .named)))"
  }
}
