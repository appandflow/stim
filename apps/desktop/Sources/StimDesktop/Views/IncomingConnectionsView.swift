import AppKit
import StimKit
import StimStores
import SwiftUI

/// The "Using this machine" side of Settings > Connections: whether other devices may connect, then the phones and
/// machines that use this machine from `stim-server devices --json`, its share links and the hosted sessions running
/// here.
struct IncomingConnectionsView: View {
  @ObservedObject var server: ServerController
  @ObservedObject var store: StatusStore
  let stimHome: String
  var machine: MachineSettingsStore
  var shares: WebSharesModel = .shared
  @AppStorage(AppPreferences.Key.servesPhones) private var allowsConnections = false
  @ObservedObject private var flags = FeatureFlagStore.shared
  @State private var hosted = HostedSessionsModel()
  @State private var pairing = false
  @State private var pairingModel: PairPhoneModel?
  @State private var revoking: IncomingConnection?
  @State private var renaming: IncomingConnection?
  @State private var newName = ""
  @State private var stoppingSession: HostedSession?
  @State private var explaining: AddExplanation?
  @State private var approving: ApproveMachineModel?

  var body: some View {
    IncomingConnectionsContent(
      allowsConnections: $allowsConnections, problem: problem, phoneApp: flags.phoneApp,
      connections: Connections.incoming(server.devices),
      changing: Set(server.pendingGrants.keys), errors: [server.devicesError, server.changeError].compactMap { $0 },
      keepsAwake: keepsAwake, shares: shares.shares, stopsOneShare: shares.stopsOneShare, stoppingShares: shares.stopping,
      workspaceTitle: { store.names(ofPath: $0).title }, sessions: hosted.sessions ?? [], stoppingSessions: hosted.stopping,
      addPhone: { pair(fixing: false) }, addMachine: { approving = ApproveMachineModel() },
      explain: { explaining = $0 }, fix: fix,
      setAccess: { record, control in server.grant(record, control: control) },
      rename: { connection in
        newName = connection.name
        renaming = connection
      },
      revoke: { revoking = $0 },
      stopShare: { share in Task { await shares.stop(share: share) } },
      stopWorkspaceShares: { workspace in Task { await shares.stop(workspace: workspace) } },
      stopSession: { stoppingSession = $0 },
      server: ServerStatusRows(server: server, stimHome: stimHome)
    )
    .task {
      while !Task.isCancelled {
        server.refresh()
        async let sessions: Void = hosted.refresh()
        async let listed: Void = shares.refresh()
        _ = await (sessions, listed)
        try? await Task.sleep(for: .seconds(5))
      }
    }
    .sheet(isPresented: $pairing, onDismiss: server.reloadDevices) {
      if let pairingModel { PairPhoneSheet(model: pairingModel) }
    }
    .sheet(
      isPresented: .init(get: { approving != nil }, set: { if !$0 { approving = nil } }),
      onDismiss: server.reloadDevices
    ) {
      if let approving { ApproveMachineSheet(model: approving, machineEntry: machineEntry) }
    }
    .onQuitRequested { pairing = false }
    .onReceive(OpenRequests.shared.$pairsPhone) { pairs in
      guard pairs else { return }
      OpenRequests.shared.pairsPhone = false
      guard flags.phoneApp else { return }
      pair(fixing: false)
    }
    .confirmationDialog(
      revoking.map { "Revoke \($0.name)'s access?" } ?? "",
      isPresented: .init(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
      presenting: revoking
    ) { connection in
      Button("Revoke Access", role: .destructive) {
        server.revoke(connection.records)
      }
    } message: { connection in
      Text(
        connection.kind == .device
          ? "It disconnects and must pair again to reconnect."
          : "It can no longer use this machine and must be set up here again.")
    }
    .alert(
      "Rename \(renaming?.name ?? "")", isPresented: .init(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
      presenting: renaming
    ) { connection in
      TextField("Name", text: $newName)
      Button("Rename") {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty, name != connection.name { server.rename(connection.records, to: name) }
      }
      Button("Cancel", role: .cancel) {}
    } message: { _ in
      Text("It sees the new name the next time it connects.")
    }
    .confirmationDialog(
      stoppingSession.map { "Stop \($0.client.name)'s \($0.device ?? $0.app ?? "session")?" } ?? "",
      isPresented: .init(get: { stoppingSession != nil }, set: { if !$0 { stoppingSession = nil } }),
      presenting: stoppingSession
    ) { session in
      Button("Stop", role: .destructive) { Task { await hosted.stop(session) } }
    } message: { _ in
      Text("This ends the session and deletes or parks its device on this machine.")
    }
    .alert(
      explaining?.title ?? "", isPresented: .init(get: { explaining != nil }, set: { if !$0 { explaining = nil } }),
      presenting: explaining
    ) { _ in
      Button("OK", role: .cancel) {}
    } message: { explanation in
      Text(explanation.message)
    }
  }

  private static let keepAwakeKey = "server.keepAwake"

  private var machineEntry: String? {
    guard case .running(let health, _) = server.state, let name = health.tailscale.dnsName?.split(separator: ".").first
    else { return nil }
    return SetupPortProbe.entry(
      machine: String(name), port: health.route?.state == "routed" ? health.route?.port ?? 7443 : 7443)
  }

  private var keepsAwake: Binding<Bool>? {
    guard let entry = machine.entry(Self.keepAwakeKey) else { return nil }
    return Binding(
      get: { entry.value.bool ?? false },
      set: { on in
        Task {
          _ = await machine.write(Self.keepAwakeKey, value: on ? "true" : "false", scope: .machine, cwd: NSHomeDirectory())
        }
      })
  }

  private func pair(fixing: Bool) {
    pairingModel = PairPhoneModel(stimHome: stimHome, fixing: fixing)
    pairing = true
  }

  private func fix(_ problem: ConnectionProblem) {
    switch problem {
    case .connectionsOff: allowsConnections = true
    case .noRoute where !flags.phoneApp: Task { _ = await server.setUpConnection() }
    case .tailscaleOff, .funneled, .noRoute: pair(fixing: true)
    }
  }

  private var problem: ConnectionProblem? {
    guard allowsConnections else { return server.devices.isEmpty ? nil : .connectionsOff }
    guard case .running(let health, _) = server.state else { return nil }
    if !health.tailscale.isRunning { return .tailscaleOff }
    switch health.route?.state {
    case "funneled": return .funneled
    case "missing", "unknown": return .noRoute
    default: return nil
    }
  }
}

/// Why phones and machines cannot reach this machine right now.
enum ConnectionProblem: Equatable {
  case connectionsOff, tailscaleOff, funneled, noRoute

  var text: String {
    switch self {
    case .connectionsOff: return "Connections are off, so paired phones and machines can't connect."
    case .tailscaleOff: return "Tailscale is off on this machine, so nothing can connect."
    case .funneled: return "Tailscale Funnel makes the Stim server public, so connections are refused."
    case .noRoute: return "Nothing can reach this machine yet: its private tailnet route is not set up."
    }
  }
}

/// What Add explains for a connection this tab cannot create itself.
enum AddExplanation: Identifiable {
  case shareLink

  var id: Self { self }

  var title: String {
    switch self {
    case .shareLink: return "Share a Device"
    }
  }

  var message: String {
    switch self {
    case .shareLink:
      return "Choose Share\u{2026} in a running simulator or emulator's menu to give someone a link to it."
    }
  }
}

/// The "Using this machine" list for the data it is given.
struct IncomingConnectionsContent<Server: View>: View {
  @Binding var allowsConnections: Bool
  var problem: ConnectionProblem?
  var phoneApp: Bool
  var connections: [IncomingConnection]
  var changing: Set<String> = []
  var errors: [String] = []
  var keepsAwake: Binding<Bool>?
  var shares: [WebShare]?
  var stopsOneShare = true
  var stoppingShares: Set<String> = []
  var workspaceTitle: (String) -> String
  var sessions: [HostedSession]
  var stoppingSessions: Set<String> = []
  var addPhone: () -> Void
  var addMachine: () -> Void
  var explain: (AddExplanation) -> Void
  var fix: (ConnectionProblem) -> Void
  var setAccess: (PairedDevice, Bool) -> Void
  var rename: (IncomingConnection) -> Void
  var revoke: (IncomingConnection) -> Void
  var stopShare: (WebShare) -> Void
  var stopWorkspaceShares: (String) -> Void
  var stopSession: (HostedSession) -> Void
  var server: Server

  var body: some View {
    Form {
      Section {
        allowRow
        if let problem { problemRow(problem) }
        if let keepsAwake {
          VStack(alignment: .leading, spacing: Space.xxs) {
            Toggle("Keep this machine awake", isOn: keepsAwake)
            Text("Prevent sleep while plugged in and connections are allowed.")
              .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
          }
        }
        ForEach(errors, id: \.self) { Text(abbreviatingHome($0)).foregroundStyle(Palette.error).textSelection(.enabled) }
        if connections.isEmpty {
          Text("Nothing else uses this machine yet.")
            .foregroundStyle(Palette.secondary)
        }
        ForEach(connections) { connection in
          IncomingConnectionRow(
            connection: connection, changing: connection.pairing.map { changing.contains($0.id) } ?? false,
            setAccess: { control in connection.pairing.map { setAccess($0, control) } },
            rename: { rename(connection) }, revoke: { revoke(connection) })
        }
      } header: {
        HStack {
          Text(phoneApp ? "Phones and machines using this machine" : "Devices and machines using this machine")
          Spacer()
          addMenu
        }
      }
      sharesSection
      if !sessions.isEmpty {
        Section("Running here") {
          ForEach(sessions) { session in
            HostedSessionRow(session: session, stopping: stoppingSessions.contains(session.id)) { stopSession(session) }
          }
        }
      }
      Section("Server") { server }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Palette.background)
  }

  private var allowRow: some View {
    VStack(alignment: .leading, spacing: Space.xxs) {
      Toggle("Allow connections", isOn: $allowsConnections)
      Text(
        allowsConnections
          ? "Paired devices and machines reach this machine's stim-server over your tailnet."
          : "Only this machine reaches its stim-server. Pairings are kept. Share links use their own route."
      )
      .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
    }
  }

  private var addMenu: some View {
    Menu("Add\u{2026}") {
      if phoneApp { Button("Pair a Phone\u{2026}", action: addPhone) }
      Button("Machine to Build or Run Simulators Here\u{2026}", action: addMachine)
      Button("Share Link\u{2026}") { explain(.shareLink) }
    }
    .menuStyle(.button)
    .buttonStyle(.stim(.primary))
    .fixedSize()
    .accessibilityLabel("Add a connection to this machine")
  }

  private func problemRow(_ problem: ConnectionProblem) -> some View {
    HStack(spacing: Space.md) {
      Label(problem.text, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
      Spacer()
      switch problem {
      case .connectionsOff: Button("Turn On") { fix(problem) }.buttonStyle(.stim())
      case .noRoute: Button(phoneApp ? "Fix\u{2026}" : "Set Up") { fix(problem) }.buttonStyle(.stim())
      case .tailscaleOff, .funneled:
        if phoneApp { Button("Fix\u{2026}") { fix(problem) }.buttonStyle(.stim()) }
      }
    }
  }

  @ViewBuilder private var sharesSection: some View {
    Section("Share links") {
      if let shares {
        if shares.isEmpty {
          Text("Choose Share\u{2026} in a running simulator or emulator's menu to give someone a link to it.")
            .foregroundStyle(Palette.secondary)
        }
        ForEach(shares) { share in
          ShareRow(
            share: share, workspace: workspaceTitle(share.workspace),
            isStopping: stoppingShares.contains(share.id) || stoppingShares.contains(share.workspace),
            stopsOne: stopsOneShare,
            stop: { stopsOneShare ? stopShare(share) : stopWorkspaceShares(share.workspace) })
        }
      } else {
        Text("This stim-server does not serve share links. Update Stim Desktop.").foregroundStyle(Palette.secondary)
      }
    }
  }
}

/// One phone or machine that uses this machine, with every record its key holds.
private struct IncomingConnectionRow: View {
  var connection: IncomingConnection
  var changing: Bool
  var setAccess: (Bool) -> Void
  var rename: () -> Void
  var revoke: () -> Void

  var body: some View {
    HStack(spacing: Space.lg) {
      Image(systemName: connection.kind == .machine ? "desktopcomputer" : "laptopcomputer.and.iphone")
        .iconFont(IconSize.large).foregroundStyle(Palette.accent).frame(width: 24).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xs) {
        Text(verbatim: connection.name).font(.stim(.body, weight: .semibold)).lineLimit(1)
        Text("\(connection.kindTitle) \u{00B7} \(connection.lastConnected)")
          .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        AccessPills(access: connection.access)
      }
      Spacer()
      Button("Revoke Access\u{2026}", action: revoke)
        .buttonStyle(.stim(.secondary))
        .fixedSize()
        .accessibilityLabel("Revoke \(connection.name)'s access")
      Menu {
        if let pairing = connection.pairing {
          Picker("Change Access", selection: Binding(get: { pairing.canControl }, set: setAccess)) {
            Text("View").tag(false)
            Text("Control").tag(true)
          }
          .pickerStyle(.inline)
          .disabled(changing)
        }
        Button("Rename\u{2026}", action: rename)
        Section("Record IDs") {
          ForEach(connection.records) { record in
            Button("Copy \(record.id)") {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(record.id, forType: .string)
            }
          }
        }
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel("More actions for \(connection.name)")
    }
    .padding(.vertical, Space.xxs)
  }
}

private struct ShareRow: View {
  var share: WebShare
  var workspace: String
  var isStopping: Bool
  var stopsOne: Bool
  var stop: () -> Void

  var body: some View {
    HStack(spacing: Space.lg) {
      Image(systemName: share.platform == "ios" ? "iphone" : "smartphone").iconFont(IconSize.large)
        .foregroundStyle(Palette.accent).frame(width: 24).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(verbatim: "\(workspace) \u{00B7} \(share.platformLabel)").font(.stim(.body, weight: .semibold))
          .lineLimit(1)
        Text("\(share.viewersLabel), \(share.timeLeft())").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      }
      Spacer()
      if share.auth == .none { Pill("No password", tone: .warning, size: .small) }
      AccessPills(access: [.shareLink])
      Pill(share.accessLabel, tone: share.control ? .success : .neutral, size: .small)
      Button(stopsOne ? "Stop" : "Stop All", role: .destructive, action: stop)
        .buttonStyle(.stim(.destructive))
        .disabled(isStopping)
        .help(stopsOne ? "Ends the link to this device" : "Ends the links to all of this workspace's devices")
    }
    .padding(.vertical, Space.xxs)
    .accessibilityElement(children: .contain)
  }
}

struct HostedSessionRow: View {
  var session: HostedSession
  var stopping: Bool
  var stop: () -> Void

  var body: some View {
    HStack(spacing: Space.lg) {
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(spacing: Space.sm) {
          Text(verbatim: session.client.name).font(.stim(.body, weight: .semibold))
          Pill(stopping ? "Stopping" : session.stateLabel, tone: tone, size: .small)
        }
        Text(verbatim: [session.device, session.app].compactMap { $0 }.joined(separator: " \u{00B7} "))
          .font(.stim(.caption))
          .foregroundStyle(Palette.secondary)
        Text(session.sinceText()).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
      Spacer()
      if !session.parked, session.state != .stopped {
        Button("Stop", role: .destructive, action: stop)
          .disabled(stopping || session.state == .stopping)
      }
    }
    .padding(.vertical, Space.xxs)
  }

  private var tone: Tone {
    if stopping || session.parked { return .neutral }
    switch session.state {
    case .ready: return .success
    case .unknown: return .warning
    default: return .neutral
    }
  }
}
