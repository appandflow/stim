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
      VStack(alignment: .leading, spacing: 28) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Needs attention").font(Theme.heading(22))
          Text("Run a fix here, or copy the command and hand it to an agent.").foregroundStyle(Theme.secondary)
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
                : "Show \(groups.count - shown.count) more \(groups.count - shown.count == 1 ? "workspace" : "workspaces")"
            ) { expanded.toggle() }
            .buttonStyle(.link)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
      .padding(28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var divider: some View {
    Rectangle().fill(Theme.border).frame(height: 1)
  }

  private var cleanup: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Machine cleanup").font(Theme.heading(15))
      Card {
        HStack(spacing: 14) {
          Image(systemName: "trash").foregroundStyle(Theme.lavender)
          VStack(alignment: .leading, spacing: 3) {
            Text("Reclaim what Stim left behind")
            Text("Preview the stim gc report, then confirm before anything is deleted.")
              .font(Theme.body(11.5)).foregroundStyle(Theme.secondary)
          }
          Spacer()
          runButton(
            "Preview cleanup", StimCommand(["gc", "--json"], cwd: NSHomeDirectory()), key: ActionCenter.machineKey)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
    }
  }

  @ViewBuilder
  private func runButton(_ title: String, _ command: StimCommand, key: String? = nil, runTitle: String? = nil) -> some View {
    if let active = actions.active(for: key ?? command.cwd) {
      Button {
        actions.presented = active
      } label: {
        HStack(spacing: 6) {
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
    HStack(spacing: 8) {
      Text(env.names.title).font(Theme.heading(13))
      Text(store.project(of: env).name).font(Theme.body(11.5)).foregroundStyle(Theme.secondary)
      Spacer()
      Text(env.live ? "live" : "idle").font(Theme.body(11.5)).foregroundStyle(env.live ? Theme.live : Theme.tertiary)
    }
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 2)
  }

  private func row(_ item: AttentionItem, workspace: Workspace) -> some View {
    HStack(spacing: 14) {
      Image(systemName: item.isError ? "xmark.octagon" : "exclamationmark.triangle")
        .foregroundStyle(item.isError ? Theme.error : Theme.warn)
      VStack(alignment: .leading, spacing: 3) {
        Text(abbreviatingHome(item.text)).lineLimit(2)
        if let command = item.command {
          Text("stim \(command.arguments.joined(separator: " "))").font(Theme.mono(11.5)).foregroundStyle(
            Theme.secondary)
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
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  private func finishedRow(_ flag: PullRequestCleanup.Flag) -> some View {
    HStack(spacing: 14) {
      Image(systemName: "arrow.triangle.pull").foregroundStyle(Theme.warn)
      VStack(alignment: .leading, spacing: 3) {
        Text(PathNames(path: flag.path).title)
        Text(flag.text).font(Theme.body(11.5)).foregroundStyle(Theme.secondary).lineLimit(2)
        Text(abbreviatingHome(flag.path)).font(Theme.mono(11.5)).foregroundStyle(Theme.tertiary).lineLimit(1)
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
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  private func group<Content: View>(_ title: String, count: Int, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text(title).font(Theme.heading(15))
        Text("\(count)").foregroundStyle(Theme.tertiary)
      }
      if count == 0 {
        Text("Nothing here.").foregroundStyle(Theme.tertiary)
      } else {
        Card { VStack(spacing: 0) { content() } }
      }
    }
  }
}
