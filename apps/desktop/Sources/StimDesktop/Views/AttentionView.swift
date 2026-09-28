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
    let items = store.attention(lowestVolume: autopilot.lowestVolume)
    let machine = items.filter { $0.workspace == nil }
    let groups = Dictionary(grouping: items.compactMap { item in item.workspace.map { ($0, item) } }, by: \.0)
    let paths = items.compactMap(\.workspace).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
    let shown = expanded ? paths : Array(paths.prefix(Self.collapsedGroups))
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        VStack(alignment: .leading, spacing: Space.xs) {
          Text("Needs attention").font(.stim(.title))
          Text("What agents cannot handle for you. Run a fix here, or copy the command and hand it to an agent.")
            .foregroundStyle(Palette.secondary)
        }
        if items.isEmpty && autopilot.finishedPullRequests.isEmpty {
          VStack(spacing: Space.md) {
            Image(systemName: "checkmark.circle").font(.system(size: 28)).foregroundStyle(Palette.success)
            Text("Nothing needs you right now").font(.stim(.headline))
            Text("Agents handle log errors and failed runs themselves. Setup, signing, leases and stuck agents show up here.")
              .foregroundStyle(Palette.secondary).multilineTextAlignment(.center)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, Space.xxxl)
        }
        if !machine.isEmpty {
          group("Machine", count: machine.count) {
            ForEach(Array(machine.enumerated()), id: \.element.id) { index, item in
              if index > 0 { divider }
              row(item, workspace: nil)
            }
          }
        }
        if !autopilot.finishedPullRequests.isEmpty {
          group("Finished pull requests", count: autopilot.finishedPullRequests.count) {
            ForEach(Array(autopilot.finishedPullRequests.enumerated()), id: \.element.path) { index, flag in
              if index > 0 { divider }
              finishedRow(flag)
            }
          }
        }
        if !paths.isEmpty {
          group("Workspaces", count: items.count - machine.count) {
            ForEach(Array(shown.enumerated()), id: \.element) { index, path in
              if index > 0 { divider }
              workspaceHeader(path)
              ForEach(groups[path]?.map(\.1) ?? [], id: \.id) { item in
                row(item, workspace: path)
              }
            }
            if paths.count > Self.collapsedGroups {
              divider
              Button(
                expanded
                  ? "Show fewer"
                  : "Show \(countLabel(paths.count - shown.count, "more workspace", plural: "more workspaces"))"
              ) { expanded.toggle() }
              .buttonStyle(.link)
              .padding(.horizontal, Space.xl)
              .padding(.vertical, Space.md)
              .frame(maxWidth: .infinity, alignment: .leading)
            }
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

  @ViewBuilder
  private func runButton(_ title: String, _ command: StimCommand, runTitle: String? = nil) -> some View {
    if let active = actions.active(for: command.cwd) {
      Button {
        actions.presented = active
      } label: {
        HStack(spacing: Space.sm) {
          ProgressView().controlSize(.small)
          Text("Running")
        }
      }
    } else {
      Button(title) { actions.run(runTitle ?? title, command) }
        .help(command.displayLine())
    }
  }

  private func workspaceHeader(_ path: String) -> some View {
    let env = store.payload?.environments.first { $0.path == path }
    return HStack(spacing: Space.md) {
      Text(store.names(ofPath: path).title).font(.stim(.body, weight: .semibold))
      if let env { Text(store.project(of: env).name).font(.stim(.footnote)).foregroundStyle(Palette.secondary) }
      Spacer()
      if let env {
        Text(env.live ? "live" : env.isSettingUp ? (env.phase ?? "idle") : "idle").font(.stim(.footnote))
          .foregroundStyle(env.live ? Palette.success : env.isSettingUp ? Palette.accent : Palette.tertiary)
      }
    }
    .padding(.horizontal, Space.xl)
    .padding(.top, Space.lg)
    .padding(.bottom, Space.xxs)
  }

  private func row(_ item: NeedsAttentionItem, workspace: String?) -> some View {
    HStack(spacing: Space.lg) {
      Image(systemName: icon(item))
        .foregroundStyle(item.isError ? Palette.error : Palette.warning)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(abbreviatingHome(item.body)).lineLimit(2)
        if let command = item.command {
          Text("stim \(command.arguments.joined(separator: " "))").font(.stim(.footnote, mono: true)).foregroundStyle(
            Palette.secondary)
        }
      }
      Spacer()
      if let workspace, item.category == .looping || item.category == .stuck || item.id.hasPrefix("run-") {
        Button("Open logs") { openLogs(workspace) }
          .help("Show this workspace's errors")
      }
      if let command = item.command {
        Button("Copy command") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(command.shellLine, forType: .string)
        }
        .help(command.displayLine())
        if item.runnable {
          runButton("Run", command, runTitle: "Fix \(store.names(ofPath: command.cwd).title)")
        }
      }
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private func icon(_ item: NeedsAttentionItem) -> String {
    switch item.category {
    case .stuck: return "hourglass"
    case .looping: return "arrow.triangle.2.circlepath"
    case .machine: return "internaldrive"
    case .attention: return item.isError ? "xmark.octagon" : "exclamationmark.triangle"
    }
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
      Card { VStack(spacing: 0) { content() } }
    }
  }
}
