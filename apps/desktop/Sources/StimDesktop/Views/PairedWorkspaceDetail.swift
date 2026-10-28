import StimKit
import StimStores
import SwiftUI

/// How the workspace screens treat the workspace they show: this Mac's own, or one a paired server owns and reports.
/// A workspace screen reads it from the environment; the default is this Mac's own workspace, which leaves every
/// control as it is.
struct WorkspaceAccess {
  var owner: ServerOwner = .local
  var serverName = ""
  var access: PairedAccess? = nil
  var link: ServerLink = .connecting
  var connectionLine: String? = nil
  var running: String? = nil
  var outcome: PairedActionOutcome? = nil
  var run: (String) -> Void = { _ in }

  static let local = WorkspaceAccess()

  var isLocal: Bool { owner.isLocal }
  var canControl: Bool { access?.canControl == true }

  func offers(_ action: String) -> Bool { access?.actions.contains(action) == true }

  /// Why a control that needs this Mac's files, logs or `stim` cannot work on the owner's workspace; nil on this Mac's own.
  var unavailableReason: String? {
    isLocal
      ? nil : "This needs files, logs or stim on \(serverName). Stim Desktop shows the workspace as \(serverName) reports it."
  }

  /// Why `action` cannot run through the owner.
  func reason(for action: String) -> String {
    access?.reason ?? "\(serverName) does not offer \(action)."
  }
}

extension EnvironmentValues {
  @Entry var workspaceAccess = WorkspaceAccess.local
}

/// A paired server's workspace on the regular workspace screen, fed from the status payload that server reported.
struct PairedWorkspaceDetail: View {
  @ObservedObject var store: StatusStore
  var key: WorkspaceKey
  var cli: Task<StimCLI, Never>
  var statsReader: StatsReader
  var inspector: InspectorPresentation
  @Binding var inspectorWidth: CGFloat
  @Binding var focusedID: String?
  @ObservedObject private var sessions = PairedServerSessions.shared
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
      Group {
        if let session {
          ObservedSession(session: session) { screen(owned.workspace) }
        } else {
          screen(owned.workspace)
        }
      }
      .onChange(of: key) { _, _ in outcome = nil }
    } else if pairingID.flatMap({ store.paired[$0]?.payload }) == nil {
      EmptyState(title: "Waiting for \(serverName)", message: "Stim Desktop shows this workspace once the machine reports it.")
    } else {
      EmptyState(title: "Workspace Gone", message: "\(serverName) no longer reports this workspace.")
    }
  }

  private var session: ServerSession? { ServerSession.session(for: key.owner) }

  private func screen(_ workspace: Workspace) -> some View {
    WorkspaceDetail(
      cli: cli, statsReader: statsReader, env: workspace, page: WorktreePage.groups(environments: [workspace])[0],
      selectedPath: workspace.path, sampled: [:], usage: nil, machine: nil,
      reportsBundles: workspace.metro?.bundle != nil, history: OwnerHistory(), inspector: inspector,
      inspectorWidth: $inspectorWidth, focusedID: $focusedID, logQuery: .constant(LogQuery()),
      logWorkspacePath: .constant(nil)
    )
    .environment(
      \.workspaceAccess,
      WorkspaceAccess(
        owner: key.owner, serverName: serverName, access: session?.pairedAccess,
        link: ServerSession.link(for: key.owner), connectionLine: connectionLine, running: running, outcome: outcome,
        run: { run($0, workspace: workspace) })
    )
    .id(key.id)
  }

  private var connectionLine: String? {
    guard let id = pairingID else { return nil }
    guard store.paired[id]?.delivering != true else { return nil }
    if let since = sessions.sessions[id]?.offlineSince {
      return "Offline since \(since.formatted(date: .omitted, time: .shortened)). This is the last status \(serverName) reported."
    }
    return sessions.entries.first { $0.id == id }?.status.title
  }

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
}

struct PairedActionOutcome: Equatable {
  var key: WorkspaceKey
  var failed: Bool
  var message: String
}

private struct ObservedSession<Content: View>: View {
  @ObservedObject var session: ServerSession
  @ViewBuilder var content: () -> Content

  var body: some View { content() }
}

/// The paired workspace's Stop and Reload App buttons, each enabled only when the owning server offers it.
struct PairedWorkspaceActions: View {
  var env: Workspace
  @Environment(\.workspaceAccess) private var access
  @State private var confirmingStop = false

  var body: some View {
    HStack(spacing: Space.sm) {
      ForEach(PairedAccess.known, id: \.self) { action in
        let offered = access.offers(action)
        Button(
          action == "stop" ? "Stop" : "Reload App", systemImage: action == "stop" ? "stop.circle" : "arrow.clockwise"
        ) {
          if action == "stop" { confirmingStop = true } else { access.run(action) }
        }
        .buttonStyle(.stim(action == "stop" ? .destructive : .secondary))
        .disabled(!offered || access.running != nil)
        .help(
          offered
            ? (action == "stop"
              ? "Runs stim stop on \(access.serverName): stops this workspace's dev server and devices there."
              : "Runs stim reload on \(access.serverName): reloads the workspace's running apps.")
            : access.reason(for: action))
      }
    }
    .fixedSize()
    .confirmationDialog(
      Text(verbatim: "Stop \(env.names.title) on \(access.serverName)?"), isPresented: $confirmingStop,
      titleVisibility: .visible
    ) {
      Button("Stop", role: .destructive) { access.run("stop") }
    } message: {
      Text(verbatim: "\(access.serverName) runs stim stop in this workspace, halting its dev server and devices there.")
    }
  }
}

/// Under the header of a paired workspace: whose it is, what this Mac may do with it, the path there, whether the
/// connection is live and the last action's outcome.
struct PairedOwnerLine: View {
  var env: Workspace
  @Environment(\.workspaceAccess) private var access

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.md) {
        Label {
          Text(
            verbatim: access.canControl
              ? "Controlled by \(access.serverName)" : "Viewing \(access.serverName) \u{00B7} read-only")
        } icon: {
          Image(systemName: access.canControl ? "person.badge.key" : "eye")
        }
        .foregroundStyle(Palette.secondary)
        .fixedSize()
        .help(
          Text(verbatim: "\(access.serverName) controls this workspace. Stim Desktop shows it as that machine reports it."))
        Pill(tone: access.canControl ? .brand : .neutral, size: .small) {
          Text(access.canControl ? "View and Control" : "View Only")
        }
        Text(verbatim: env.path).font(.stim(.caption, mono: true)).foregroundStyle(Palette.tertiary).lineLimit(1)
          .truncationMode(.head).textSelection(.enabled)
      }
      if let connectionLine = access.connectionLine {
        Text(verbatim: connectionLine).font(.stim(.caption)).foregroundStyle(Palette.warning)
      }
      if let outcome = access.outcome, outcome.key == WorkspaceKey(owner: access.owner, path: env.path) {
        Text(verbatim: outcome.message).font(.stim(.caption))
          .foregroundStyle(outcome.failed ? Palette.error : Palette.secondary)
      } else if let reason = access.access?.reason {
        Text(verbatim: reason).font(.stim(.caption)).foregroundStyle(Palette.secondary).textSelection(.enabled)
      }
    }
  }
}
