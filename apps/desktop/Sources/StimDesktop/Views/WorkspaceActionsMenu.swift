import AppKit
import StimKit
import SwiftUI

/// The action set shared by the sidebar's row context menu and the workspace detail's "..." menu, built from
/// `workspaceMenuItems(for:)` so the two never drift apart. A `nil` action closure hides that item, which
/// covers cases `kind` alone does not decide: no editor or terminal is installed, or there is no previous
/// run to show output for.
struct WorkspaceActionsMenu: View {
  var kind: ActionRowKind
  var path: String
  var busy: Bool
  var removalAllowed: Bool
  var building: Bool = false
  var reloadAllowed: Bool = true
  var onShowLastOutput: (() -> Void)?
  var onRun: ((String) -> Void)?
  var onReload: (() -> Void)?
  var onStartDevServer: (() -> Void)?
  var onStopDevServer: (() -> Void)?
  var onShowLogs: (() -> Void)?
  var onWarmWorktree: (() -> Void)?
  var onRemoveWorktree: (() -> Void)?
  var onStopAllLiveWorkspaces: (() -> Void)?
  @AppStorage(AppPreferences.Key.editorBundleID) private var editorID = ""
  @AppStorage(AppPreferences.Key.terminalBundleID) private var terminalID = ""

  var body: some View {
    ForEach(Array(workspaceMenuItems(for: kind).enumerated()), id: \.offset) { _, item in
      if let item {
        button(for: item)
      } else {
        Divider()
      }
    }
  }

  @ViewBuilder
  private func button(for item: WorkspaceMenuItem) -> some View {
    switch item {
    case .openInEditor:
      if let editor = chosenExternalApp(editorID, from: ExternalApp.editors) {
        Button("Open in \(editor.name)", systemImage: "chevron.left.forwardslash.chevron.right") {
          openInExternalApp(path, in: editor)
        }
      }
    case .openInTerminal:
      if let terminal = chosenExternalApp(terminalID, from: ExternalApp.terminals) {
        Button("Open in \(terminal.name)", systemImage: "terminal") { openInExternalApp(path, in: terminal) }
      }
    case .revealInFinder:
      Button("Reveal in Finder", systemImage: "folder") {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
      }
    case .copyPath:
      Button("Copy path", systemImage: "doc.on.doc") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
      }
    case .lastOutput:
      if let onShowLastOutput {
        Button("Last output", systemImage: "doc.plaintext", action: onShowLastOutput)
      }
    case .run(let platform):
      if let onRun {
        Button("Run on \(platformName(platform))", systemImage: "play.fill") { onRun(platform) }
          .disabled(busy || building)
          .help(building ? "A build is already running in this workspace." : "stim \(platform)")
      }
    case .reload:
      if let onReload {
        Button("Reload app", systemImage: "arrow.clockwise", action: onReload)
          .disabled(busy || !reloadAllowed)
          .help(reloadAllowed ? "" : "Reload needs a running dev server and device.")
      }
    case .startDevServer:
      if let onStartDevServer {
        Button("Start dev server", systemImage: "play", action: onStartDevServer).disabled(busy)
      }
    case .stopDevServer:
      if let onStopDevServer {
        Button("Stop", systemImage: "stop.circle", action: onStopDevServer).disabled(busy)
      }
    case .showLogs:
      if let onShowLogs {
        Button("Show logs", systemImage: "text.alignleft", action: onShowLogs)
      }
    case .warmWorktree:
      if let onWarmWorktree {
        Button("Warm worktree", systemImage: "flame", action: onWarmWorktree).disabled(busy)
      }
    case .removeWorktree:
      if let onRemoveWorktree {
        Button("Remove worktree\u{2026}", systemImage: "trash", role: .destructive, action: onRemoveWorktree)
          .disabled(busy || !removalAllowed)
          .help(removalAllowed ? "" : "Stim refuses to remove a worktree with uncommitted or unpushed work.")
      }
    case .stopAllLiveWorkspaces:
      if let onStopAllLiveWorkspaces {
        Button("Stop all live workspaces", systemImage: "stop.circle", action: onStopAllLiveWorkspaces).disabled(busy)
      }
    }
  }
}

/// The preferred editor or terminal, or the first installed one, matching `Inspector`'s resolution.
func chosenExternalApp(_ preferred: String, from apps: [ExternalApp]) -> ExternalApp? {
  ExternalApp.choose(preferred, from: apps) { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) != nil }
}

func openInExternalApp(_ path: String, in app: ExternalApp) {
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: app.bundleID) else { return }
  NSWorkspace.shared.open([URL(fileURLWithPath: path)], withApplicationAt: url, configuration: NSWorkspace.OpenConfiguration())
}

/// Reads the worktree's current branch off the main thread, then hands it to `set` for a removal confirmation.
func resolveRemovalBranch(at path: String, set: @escaping (String?) -> Void) {
  Task {
    let branch = await Task.detached { currentBranch(at: path) }.value
    set(branch)
  }
}

/// The worktree branch a "Remove worktree" confirmation dialog is about to remove, resolved asynchronously.
struct WorktreeRemoval {
  var branch: String?
}

/// The explanation shown in a "Remove worktree" confirmation dialog, shared by the sidebar's context menu and
/// the workspace detail's "..." menu.
func worktreeRemovalMessage(path: String, branch: String?) -> String {
  """
  Worktree: \(abbreviatingHome(path))
  Branch: \(branch ?? "none (detached HEAD)")

  Stim deletes the worktree, its branch when Stim created it and nothing else uses it, \
  its build artifacts, owned devices and Metro port. It refuses when the worktree holds \
  uncommitted or unpushed work. On the source checkout it reclaims the environment only \
  and leaves the tree in place.
  """
}
