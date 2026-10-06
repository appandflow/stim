import StimKit
import SwiftUI

struct WorkspaceDiffView: View {
  var cli: Task<StimCLI, Never>
  var workspace: String
  @ObservedObject private var server = ServerSession.shared
  @Environment(\.dismiss) private var dismiss
  @State private var group = "changed"
  @State private var files: WorkspaceFiles?
  @State private var selected: String?
  @State private var patch: WorkspaceDiff?
  @State private var rows: [WorkspaceDiffRow] = []
  @State private var listError: String?
  @State private var patchError: String?
  @State private var refresh = 0
  @State private var home: String?
  @State private var loadedKey: String?

  private var connection: ServerClient? {
    guard let home, let connection = server.statsConnection,
      URL(fileURLWithPath: connection.home).resolvingSymlinksInPath().path == home,
      case .open(let hello) = connection.client.state,
      hello.features?.contains("workspace-diff") == true, hello.capabilities.contains("read")
    else { return nil }
    return connection.client
  }

  private var listKey: String {
    "\(workspace) \(group) \(refresh) \(connection.map { String(describing: ObjectIdentifier($0)) } ?? "closed")"
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: Space.md) {
        Text("Workspace changes").font(.stim(.headline))
        Spacer()
        Button("Refresh", systemImage: "arrow.clockwise") { refresh += 1 }.disabled(connection == nil)
        Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      .padding(Space.lg)
      Divider()
      if connection == nil {
        Text(unavailable).foregroundStyle(Palette.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity).padding(Space.xxl)
      } else {
        HSplitView {
          fileList.frame(minWidth: 200, idealWidth: 240, maxWidth: 320)
          diff.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
    .background(Palette.background)
    .frame(minWidth: 640, idealWidth: 900, minHeight: 440, idealHeight: 600)
    .task {
      let cli = await cli.value
      home = URL(fileURLWithPath: cli.stimHome).resolvingSymlinksInPath().path
    }
    .task(id: listKey) {
      let key = listKey
      loadedKey = nil
      files = nil
      selected = nil
      patch = nil
      listError = nil
      guard let connection else { return }
      do {
        let result = try await connection.request("workspace.files", ["workspace": .string(workspace), "group": .string(group)])
        let loaded = try JSONDecoder().decode(WorkspaceFiles.self, from: JSONEncoder().encode(result))
        try Task.checkCancellation()
        files = loaded
        loadedKey = key
      } catch {
        if !Task.isCancelled { listError = error.localizedDescription }
      }
    }
    .task(id: "\(listKey) \(selected ?? "")") {
      patch = nil
      rows = []
      patchError = nil
      guard loadedKey == listKey, let connection, let selected else { return }
      do {
        try await Task.sleep(for: .milliseconds(150))
        let result = try await connection.request("workspace.diff", ["workspace": .string(workspace), "path": .string(selected)])
        let loaded = try JSONDecoder().decode(WorkspaceDiff.self, from: JSONEncoder().encode(result))
        try Task.checkCancellation()
        patch = loaded
        rows = loaded.rows
      } catch {
        if !Task.isCancelled { patchError = error.localizedDescription }
      }
    }
  }

  private var unavailable: String {
    switch server.link {
    case .open(let features, let capabilities):
      if !capabilities.contains("read") { return "This connection needs read access to review changes." }
      if features?.contains("workspace-diff") != true {
        return "This server does not offer workspace diffs. Update stim-server and reconnect."
      }
      guard let home else { return "Preparing the workspace connection" }
      if let connection = server.statsConnection,
        URL(fileURLWithPath: connection.home).resolvingSymlinksInPath().path != home
      {
        return "The server uses a different Stim home from the workspace. Connect to the workspace's server."
      }
      return "Connecting to stim-server"
    case .unavailable(let reason): return reason
    case .off: return "Turn on Serve to phones on the Phones page to use the built-in diff viewer."
    case .connecting: return "Connecting to stim-server"
    }
  }

  private var fileList: some View {
    VStack(spacing: Space.md) {
      Picker("Files", selection: $group) {
        Text("Changed").tag("changed")
        Text("New").tag("untracked")
      }
      .pickerStyle(.segmented).padding([.top, .horizontal], Space.md)
      if let listError {
        Text(listError).foregroundStyle(Palette.warning).textSelection(.enabled).padding(Space.md)
        Spacer()
      } else if let files {
        if files.files.isEmpty {
          InlineEmpty("No \(group == "changed" ? "changed" : "new") files")
          Spacer()
        } else {
          List(files.files, selection: $selected) { file in
            VStack(alignment: .leading, spacing: Space.xs) {
              Text(file.path).lineLimit(2).truncationMode(.middle)
              Text(
                file.untracked
                  ? "New"
                  : [file.staged ? "Staged" : nil, file.unstaged ? "Unstaged" : nil].compactMap { $0 }.joined(separator: " / ")
              )
              .font(.stim(.caption)).foregroundStyle(.secondary)
            }
            .tag(file.path)
          }
          .scrollContentBackground(.hidden)
        }
        if files.truncated {
          Text("Showing the first 200 files").font(.stim(.footnote)).foregroundStyle(Palette.warning).padding(Space.md)
        }
      } else {
        ProgressView().padding(Space.lg)
        Spacer()
      }
    }
  }

  @ViewBuilder private var diff: some View {
    if let patchError {
      Text(patchError).foregroundStyle(Palette.warning).textSelection(.enabled).padding(Space.lg)
    } else if let patch {
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0) {
          Text(patch.path).font(.stim(.headline)).padding(Space.lg)
          ForEach(rows) { row in
            switch row.kind {
            case .title:
              Text(row.text).font(.stim(.callout, weight: .semibold)).padding(Space.lg)
            case .note:
              Text(row.text).foregroundStyle(Palette.secondary).textSelection(.enabled).padding(Space.lg)
            default:
              Text(row.text.isEmpty ? " " : row.text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(color(for: row.kind))
                .textSelection(.enabled).fixedSize(horizontal: true, vertical: false).padding(.horizontal, Space.lg)
            }
          }
          if patch.patches.isEmpty { InlineEmpty("No diff available").padding(Space.lg) }
        }
      }
    } else if selected != nil {
      ProgressView()
    } else {
      Text("Choose a file to review its changes").foregroundStyle(Palette.secondary)
    }
  }

  private func color(for kind: WorkspaceDiffRow.Kind) -> Color {
    switch kind {
    case .added: return Palette.success
    case .removed: return Palette.error
    case .hunk: return Palette.accent
    case .title, .note, .plain, .context: return Palette.text
    }
  }
}
