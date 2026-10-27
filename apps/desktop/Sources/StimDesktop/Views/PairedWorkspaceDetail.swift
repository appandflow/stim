import StimKit
import StimStores
import SwiftUI

struct PairedWorkspaceDetail: View {
  @ObservedObject var store: StatusStore
  var key: WorkspaceKey
  @ObservedObject private var sessions = PairedServerSessions.shared

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
      ScrollView { PairedWorkspacePage(owned: owned, serverName: serverName, connectionLine: connectionLine) }
    } else if pairingID.flatMap({ store.paired[$0]?.payload }) == nil {
      EmptyState(title: "Waiting for \(serverName)", message: "Stim Desktop shows this workspace once the machine reports it.")
    } else {
      EmptyState(title: "Workspace Gone", message: "\(serverName) no longer reports this workspace.")
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

struct PairedWorkspacePage: View {
  var owned: OwnedWorkspace
  var serverName: String
  var connectionLine: String?

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
      Label {
        Text(verbatim: "Viewing \(serverName) \u{00B7} read-only")
      } icon: {
        Image(systemName: "eye")
      }
      .foregroundStyle(Palette.secondary)
      .help(Text(verbatim: "\(serverName) controls this workspace. Stim Desktop shows it as that machine reports it."))
      Text(verbatim: env.path).font(.stim(.caption, mono: true)).foregroundStyle(Palette.tertiary).lineLimit(1)
        .truncationMode(.head).textSelection(.enabled)
      if let line = connectionLine { Text(verbatim: line).font(.stim(.caption)).foregroundStyle(Palette.warning) }
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
        row(
          icon: ref.platform == "android" ? "smartphone" : ref.platform == "web" ? "globe" : "iphone", agent: nil,
          title: "\(ref.model) \u{00B7} \(ref.state)",
          detail: [place, driver].compactMap { $0 }.joined(separator: " \u{00B7} "))
      }
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
