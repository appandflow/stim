import AppKit
import StimKit
import SwiftUI

struct AttentionView: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var autopilot: AutopilotRunner
  var openLogs: (String) -> Void
  @EnvironmentObject private var actions: ActionCenter
  @State private var expanded = false

  private static let collapsedGroups = 3

  var body: some View {
    let groups = attentionGroups(store.payload?.environments ?? [])
    let shown = expanded ? groups : Array(groups.prefix(Self.collapsedGroups))
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        VStack(alignment: .leading, spacing: Space.xs) {
          Text("Needs attention").font(.stim(.title))
          Text("Run a fix here, or copy the command and hand it to an agent.").foregroundStyle(Palette.secondary)
        }
        cleanup
        if !autopilot.finishedPullRequests.isEmpty {
          group("Finished pull requests", count: autopilot.finishedPullRequests.count) {
            ForEach(Array(autopilot.finishedPullRequests.enumerated()), id: \.element.path) { index, flag in
              if index > 0 { divider }
              finishedRow(flag)
            }
          }
        }
        group("Problems", count: groups.reduce(0) { $0 + $1.items.count }) {
          ForEach(Array(shown.enumerated()), id: \.element.workspace.path) { index, group in
            if index > 0 { divider }
            workspaceHeader(group.workspace)
            ForEach(Array(group.items.enumerated()), id: \.offset) { _, item in
              row(item, workspace: group.workspace)
            }
          }
          if groups.count > Self.collapsedGroups {
            divider
            Button(
              expanded
                ? "Show fewer"
                : "Show \(countLabel(groups.count - shown.count, "more workspace", plural: "more workspaces"))"
            ) { expanded.toggle() }
            .buttonStyle(.link)
            .padding(.horizontal, Space.xl)
            .padding(.vertical, Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
      .padding(Space.xxxl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var divider: some View {
    Rectangle().fill(Palette.border).frame(height: 1)
  }

  private var cleanup: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      Text("Machine cleanup").font(.stim(.headline))
      Card {
        HStack(spacing: Space.lg) {
          Image(systemName: "trash").foregroundStyle(Palette.accent)
          VStack(alignment: .leading, spacing: Space.xxs) {
            Text("Reclaim what Stim left behind")
            Text("Preview the stim gc report, then confirm before anything is deleted.")
              .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
          }
          Spacer()
          runButton(
            "Preview cleanup", StimCommand(["gc", "--json"], cwd: NSHomeDirectory()), key: ActionCenter.machineKey)
        }
        .padding(.horizontal, Space.xl)
        .padding(.vertical, Space.lg)
      }
    }
  }

  @ViewBuilder
  private func runButton(_ title: String, _ command: StimCommand, key: String? = nil, runTitle: String? = nil) -> some View {
    if let active = actions.active(for: key ?? command.cwd) {
      Button {
        actions.presented = active
      } label: {
        HStack(spacing: Space.sm) {
          ProgressView().controlSize(.small)
          Text("Running")
        }
      }
    } else {
      Button(title) { actions.run(runTitle ?? title, command, key: key) }
        .help(command.displayLine())
    }
  }

  private func workspaceHeader(_ env: Workspace) -> some View {
    HStack(spacing: Space.md) {
      Text(env.names.title).font(.stim(.body, weight: .semibold))
      Text(store.project(of: env).name).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      Spacer()
      Text(env.live ? "live" : "idle").font(.stim(.footnote)).foregroundStyle(env.live ? Palette.success : Palette.tertiary)
    }
    .padding(.horizontal, Space.xl)
    .padding(.top, Space.lg)
    .padding(.bottom, Space.xxs)
  }

  private func row(_ item: AttentionItem, workspace: Workspace) -> some View {
    HStack(spacing: Space.lg) {
      Image(systemName: item.isError ? "xmark.octagon" : "exclamationmark.triangle")
        .foregroundStyle(item.isError ? Palette.error : Palette.warning)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(abbreviatingHome(item.text)).lineLimit(2)
        if let detail = item.detail {
          Text(detail).font(.stim(.footnote, mono: true)).foregroundStyle(Palette.error).lineLimit(3).textSelection(.enabled)
        }
        if let command = item.command {
          Text("stim \(command.arguments.joined(separator: " "))").font(.stim(.footnote, mono: true)).foregroundStyle(
            Palette.secondary)
        }
      }
      Spacer()
      if item.opensLogs {
        Button("Open logs") { openLogs(workspace.path) }
          .help("Show this workspace's errors")
      }
      if let command = item.command {
        Button("Copy command") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(command.shellLine, forType: .string)
        }
        .help(command.displayLine())
        if item.runnable {
          runButton("Run", command, runTitle: "Fix \(workspace.names.title)")
        }
      }
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private func finishedRow(_ flag: PullRequestCleanup.Flag) -> some View {
    HStack(spacing: Space.lg) {
      Image(systemName: "arrow.triangle.pull").foregroundStyle(Palette.warning)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(store.names(ofPath: flag.path).title)
        Text(flag.text).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(2)
        Text(abbreviatingHome(flag.path)).font(.stim(.footnote, mono: true)).foregroundStyle(Palette.tertiary).lineLimit(1)
      }
      Spacer()
      if let url = URL(string: flag.pullRequest.url) {
        Button("Open PR") { NSWorkspace.shared.open(url) }
      }
      Button("Show in Finder") {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: flag.path)])
      }
      .help("The autopilot keeps this worktree. Review it, then run stim worktree remove yourself.")
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private func group<Content: View>(_ title: String, count: Int, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.md) {
        Text(title).font(.stim(.headline))
        Text("\(count)").foregroundStyle(Palette.tertiary)
      }
      if count == 0 {
        Text("Nothing here.").foregroundStyle(Palette.tertiary)
      } else {
        Card { VStack(spacing: 0) { content() } }
      }
    }
  }
}
