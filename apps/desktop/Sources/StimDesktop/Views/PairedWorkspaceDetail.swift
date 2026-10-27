import StimKit
import StimStores
import SwiftUI

struct PairedWorkspaceDetail: View {
  @ObservedObject var store: StatusStore
  var key: WorkspaceKey
  var cli: Task<StimCLI, Never>
  @ObservedObject private var sessions = PairedServerSessions.shared
  @EnvironmentObject private var actions: ActionCenter
  @Environment(\.windowSize) private var windowSize
  @State private var viewing: ViewedDevice?
  @State private var running: String?
  @State private var outcome: PairedActionOutcome?

  private var pairingID: String? {
    if case .paired(let id) = key.owner { return id }
    return nil
  }

  private var serverName: String {
    pairingID.flatMap { id in sessions.sessions[id]?.name ?? sessions.entries.first { $0.id == id }?.pairing?.name }
      ?? "the paired machine"
  }

  var body: some View {
    if let id = pairingID, !sessions.entries.contains(where: { $0.id == id }) {
      EmptyState(title: "Machine Not Paired", message: "Stim Desktop no longer has a pairing with this machine.")
    } else if let owned = store.workspace(key) {
      ScrollView {
        PairedWorkspacePage(
          owned: owned, serverName: serverName, connectionLine: connectionLine, access: session?.pairedAccess,
          running: running, outcome: outcome, run: { run($0, workspace: owned.workspace) },
          view: { viewing = ViewedDevice(id: $0.id, workspace: owned.workspace.path) })
      }
      .sheet(item: $viewing) { viewed in
        DeviceViewer(
          cli: cli, env: owned.workspace, deviceID: viewed.id, owner: key.owner, windowSize: windowSize,
          revealInLogs: { _, _ in }, close: { viewing = nil }
        )
        .environmentObject(actions)
      }
      .onChange(of: key) { _, _ in
        viewing = nil
        outcome = nil
      }
    } else if pairingID.flatMap({ store.paired[$0]?.payload }) == nil {
      EmptyState(title: "Waiting for \(serverName)", message: "Stim Desktop shows this workspace once the machine reports it.")
    } else {
      EmptyState(title: "Workspace Gone", message: "\(serverName) no longer reports this workspace.")
    }
  }

  private var session: ServerSession? { ServerSession.session(for: key.owner) }

  private func run(_ action: String, workspace: Workspace) {
    guard running == nil, let session else { return }
    running = action
    outcome = nil
    let key = key
    Task {
      do {
        try await session.runPairedAction(action, workspace: workspace.path)
        outcome = PairedActionOutcome(
          key: key, failed: false,
          message: action == "stop" ? "Stopped \(workspace.names.title) on \(serverName)." : "Reloaded the app on \(serverName).")
      } catch {
        outcome = PairedActionOutcome(key: key, failed: true, message: error.localizedDescription)
      }
      running = nil
    }
  }

  private var connectionLine: String? {
    guard let id = pairingID else { return nil }
    let delivering = store.paired[id]?.delivering == true
    guard !delivering else { return nil }
    if let since = sessions.sessions[id]?.offlineSince {
      return "Offline since \(since.formatted(date: .omitted, time: .shortened)). This is the last status \(serverName) reported."
    }
    return sessions.entries.first { $0.id == id }?.status.title
  }
}

struct PairedActionOutcome: Equatable {
  var key: WorkspaceKey
  var failed: Bool
  var message: String
}

struct PairedWorkspacePage: View {
  var owned: OwnedWorkspace
  var serverName: String
  var connectionLine: String?
  var access: PairedAccess?
  var running: String? = nil
  var outcome: PairedActionOutcome? = nil
  var run: (String) -> Void = { _ in }
  var view: ((DeviceRef) -> Void)? = nil
  @State private var confirmingStop = false

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xxl) {
      header(owned.workspace)
      agents(owned.workspace)
      build(owned.workspace)
      devices(owned)
    }
    .padding(Space.xxxl)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func header(_ env: Workspace) -> some View {
    let status = env.rowStatus(now: Date())
    return VStack(alignment: .leading, spacing: Space.sm) {
      HStack(alignment: .firstTextBaseline, spacing: Space.md) {
        Text(verbatim: env.names.title).font(.stim(.title)).lineLimit(1).truncationMode(.middle)
        Text(verbatim: status.text).font(.stim(.body, weight: .medium)).foregroundStyle(Color(status.tone))
      }
      HStack(spacing: Space.md) {
        Label {
          Text(verbatim: canControl ? "Controlled by \(serverName)" : "Viewing \(serverName) \u{00B7} read-only")
        } icon: {
          Image(systemName: canControl ? "person.badge.key" : "eye")
        }
        .foregroundStyle(Palette.secondary)
        .help(Text(verbatim: "\(serverName) controls this workspace. Stim Desktop shows it as that machine reports it."))
        Pill(tone: canControl ? .brand : .neutral, size: .small) {
          Text(canControl ? "View and Control" : "View Only")
        }
        Spacer(minLength: Space.md)
        actionButtons(env)
      }
      Text(verbatim: env.path).font(.stim(.caption, mono: true)).foregroundStyle(Palette.tertiary).lineLimit(1)
        .truncationMode(.head).textSelection(.enabled)
      if let line = connectionLine { Text(verbatim: line).font(.stim(.caption)).foregroundStyle(Palette.warning) }
      if let outcome, outcome.key == owned.key {
        Text(verbatim: outcome.message).font(.stim(.caption))
          .foregroundStyle(outcome.failed ? Palette.error : Palette.secondary)
      } else if let reason = access?.reason {
        Text(verbatim: reason).font(.stim(.caption)).foregroundStyle(Palette.secondary).textSelection(.enabled)
      }
    }
  }

  private var canControl: Bool { access?.canControl == true }

  private func offers(_ action: String) -> Bool { access?.actions.contains(action) == true }

  private func actionButtons(_ env: Workspace) -> some View {
    let shown = canControl ? PairedAccess.known.filter(offers) : PairedAccess.known
    let reason = access?.reason ?? "Waiting for \(serverName)."
    return HStack(spacing: Space.sm) {
      ForEach(shown, id: \.self) { action in
        let label = action == "stop" ? "Stop" : "Reload App"
        Button(label, systemImage: action == "stop" ? "stop.circle" : "arrow.clockwise") {
          if action == "stop" { confirmingStop = true } else { run(action) }
        }
        .buttonStyle(.stim(action == "stop" ? .destructive : .secondary))
        .disabled(!offers(action) || running != nil)
        .help(
          offers(action)
            ? (action == "stop"
              ? "Runs stim stop on \(serverName): stops this workspace's dev server and devices there."
              : "Runs stim reload on \(serverName): reloads the workspace's running apps.")
            : reason)
      }
    }
    .confirmationDialog(
      Text(verbatim: "Stop \(env.names.title) on \(serverName)?"), isPresented: $confirmingStop, titleVisibility: .visible
    ) {
      Button("Stop", role: .destructive) { run("stop") }
    } message: {
      Text(verbatim: "\(serverName) runs stim stop in this workspace, halting its dev server and devices there.")
    }
  }

  @ViewBuilder private func agents(_ env: Workspace) -> some View {
    let sessions = AgentSession.associated(agents: env.agents, endedAgents: env.endedAgents)
    if !sessions.isEmpty {
      section("Agents") {
        ForEach(sessions) { session in
          row(
            icon: nil, agent: session.tool, title: session.title.flatMap { $0.isEmpty ? nil : $0 } ?? session.toolName,
            detail: "\(session.toolName) on \(serverName)")
        }
      }
    }
  }

  @ViewBuilder private func build(_ env: Workspace) -> some View {
    if let build = env.build, build.isRunning {
      let remote = build.remote(at: Date())
      section("Build") {
        row(
          icon: "hammer", agent: nil, title: "\(platformName(build.platform)) build",
          detail: remote.map { "Building on \($0.host) \u{00B7} \($0.phase)" }
            ?? "Building on \(serverName) \u{00B7} \(build.phase)")
      }
    }
  }

  @ViewBuilder private func devices(_ owned: OwnedWorkspace) -> some View {
    let devices = owned.devices
    section("Devices") {
      if devices.isEmpty {
        InlineEmpty("No devices")
      }
      ForEach(devices) { device in
        let ref = device.ref
        let place = ref.placement.map { "Running on \($0.machine)" } ?? "On \(serverName)"
        let driver = ref.activity?.driver.map { "\($0.tool) on \(serverName)" }
        let content = row(
          icon: ref.platform == "android" ? "smartphone" : ref.platform == "web" ? "globe" : "iphone", agent: nil,
          title: "\(ref.model) \u{00B7} \(ref.state)",
          detail: [place, driver].compactMap { $0 }.joined(separator: " \u{00B7} "))
        if let view, Self.streams(device) {
          Button {
            view(ref)
          } label: {
            HStack {
              content
              Image(systemName: "chevron.right").foregroundStyle(Palette.tertiary).accessibilityHidden(true)
                .padding(.trailing, Space.lg)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .help(Text(verbatim: "Show this device's screen through \(serverName)"))
        } else {
          content
        }
      }
    }
  }

  private static func streams(_ device: OwnedDevice) -> Bool {
    switch device.ref {
    case .ios, .android: return true
    case .macos: return device.ref.hostedMachine != nil
    case .web, .remote: return false
    }
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: title)
      Card {
        VStack(alignment: .leading, spacing: 0) { content() }
      }
    }
  }

  private func row(icon: String?, agent: String?, title: String, detail: String) -> some View {
    ListRow {
      if let agent {
        AgentIcon(tool: agent, size: 16)
      } else if let icon {
        Image(systemName: icon).foregroundStyle(Palette.tertiary).frame(width: 20).accessibilityHidden(true)
      }
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(verbatim: title).lineLimit(1).truncationMode(.middle)
        Text(verbatim: detail).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1)
      }
    }
  }
}
