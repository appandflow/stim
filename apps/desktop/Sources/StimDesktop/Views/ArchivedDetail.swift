import StimKit
import StimStores
import SwiftUI

struct ArchivedRow: View {
  var archive: ArchivedWorkspace
  var now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xxs) {
      Label(archive.title, systemImage: "archivebox").lineLimit(1)
      HStack {
        Text(archive.removedLabel(now: now))
        Spacer(minLength: Space.sm)
        Text(archive.sizeLabel)
      }
      .font(.stim(.caption)).foregroundStyle(Palette.secondary)
    }
    .padding(.vertical, Space.xs)
  }
}

struct ArchivedDetail: View {
  var archive: ArchivedWorkspace
  var environments: [Workspace]
  @Binding var selection: SidebarItem?
  #if DEBUG
    var fixtureDate: Date? = nil
    var readsServer = true
  #else
    private var fixtureDate: Date? { nil }
    private var readsServer: Bool { true }
  #endif
  @EnvironmentObject private var actions: ActionCenter
  @State private var confirmingDelete = false
  @State private var query = LogQuery()
  @State private var moment: LogMoment?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxl) {
        HStack {
          VStack(alignment: .leading, spacing: Space.sm) {
            Text(archive.title).font(.stim(.title, weight: .semibold))
            if let pr = archive.worktree.pullRequest, let url = URL(string: pr.url) {
              Link("PR #\(pr.number) \u{00B7} \(pr.title) \u{00B7} \(pr.state)", destination: url)
                .allowsHitTesting(readsServer)
            }
          }
          Spacer()
          Button("Delete", role: .destructive) { confirmingDelete = true }
            .buttonStyle(.stim(.destructive)).disabled(actions.active(for: "archive:\(archive.id)") != nil)
        }
        TimelineView(.everyMinute) { context in
          VStack(alignment: .leading, spacing: Space.sm) {
            Text("\(archive.removedLabel(now: fixtureDate ?? context.date)) by \(archive.removedByLabel)")
            if let label = archive.lastUsedLabel(now: fixtureDate ?? context.date) { Text(label) }
            Text(archive.sizeLabel)
          }.foregroundStyle(Palette.secondary)
        }
        if let path = archive.replacedBy {
          Button("Replaced by \(environments.first(where: { $0.path == path })?.names.title ?? path)") {
            selection = .environment(path)
          }.buttonStyle(.link)
        }
        VStack(alignment: .leading, spacing: Space.md) {
          SectionLabel(title: "Builds (\(archive.builds.count))")
          if let last = archive.builds.last {
            ArchivedLastBuild(build: last, workspace: archive.projectRoot)
          } else {
            InlineEmpty("No build recorded")
          }
        }
        VStack(alignment: .leading, spacing: Space.md) {
          SectionLabel(title: "Logs")
          if readsServer {
            LogsView(cli: Task { StimCLI(environment: [:]) }, env: nil, query: $query, moment: $moment, archive: archive)
              .frame(height: 400)
          } else {
            InlineEmpty("Archived logs are read through stim-server.")
          }
        }
        if readsServer && archive.bytes.recordings > 0 {
          ForEach(["ios", "android", "web"], id: \.self) { platform in
            ReplayHost(target: ReplayTarget(archive: archive.id, platform: platform)) { controller in
              ArchivedReplay(controller: controller, platform: platform)
            }
          }
        }
        if !archive.agents.isEmpty {
          AgentSessionsSection(agents: AgentSession.associated(agents: nil, endedAgents: archive.agents))
        }
      }
      .padding(Space.xxl).frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Palette.background)
    .confirmationDialog("Delete \(archive.title)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
      Button("Delete permanently", role: .destructive) {
        if let command = archive.deleteCommand(confirmed: true, cwd: NSHomeDirectory()) {
          actions.run("Delete \(archive.title)", steps: [command], key: "archive:\(archive.id)")
        }
      }
    } message: {
      Text("This permanently deletes this archive's logs, recordings, agent actions and record.")
    }
  }
}

struct ArchivedLastBuild: View {
  var build: LastBuild
  var workspace: String

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text(platformName(build.platform)).foregroundStyle(Palette.secondary)
      Text(build.summary).font(.stim(.callout, weight: .semibold))
        .foregroundStyle(build.status == "ok" ? Palette.text : Palette.error)
      OffloadFallbackLine(build: build)
      if let reason = build.missReason { MissReasonView(reason: reason) }
      if let diagnostics = build.diagnostics, !diagnostics.isEmpty {
        BuildDiagnosticsView(diagnostics: diagnostics, workspace: workspace)
      }
    }
  }
}

private struct ArchivedReplay: View {
  @ObservedObject var controller: ReplayController
  var platform: String

  var body: some View {
    if let timeline = controller.timeline {
      VStack(alignment: .leading, spacing: Space.md) {
        SectionLabel(title: "Replay \u{00B7} \(platformName(platform))")
        ReplayScreen(controller: controller, onPixelSizeChange: { _ in })
          .frame(height: 360)
        ReplayBar(controller: controller, running: false, replayOff: false)
        if let error = controller.error { Text(error).foregroundStyle(Palette.secondary) }
      }
      .onAppear { controller.seek(at: timeline.start, rate: 0) }
    } else if let error = controller.error {
      Text(error).foregroundStyle(Palette.secondary)
    }
  }
}

struct ArchivedStorageSection: View {
  var usage: ArchivedUsage

  var body: some View {
    if !usage.storageRows.isEmpty {
      VStack(alignment: .leading, spacing: Space.md) {
        SectionLabel(title: "Archived workspaces")
        Text("\(countLabel(usage.count, "archive")) \u{00B7} \(Format.fileSize(usage.bytes))")
        Text("Bounded by archive.maxTotalGb").foregroundStyle(Palette.secondary)
        ForEach(usage.storageRows, id: \.title) { row in
          HStack {
            VStack(alignment: .leading, spacing: Space.xxs) {
              Text(row.title)
              Text(row.settings).font(.stim(.caption)).foregroundStyle(Palette.secondary)
            }
            Spacer()
            Text(Format.fileSize(row.bytes)).foregroundStyle(Palette.secondary)
          }
        }
      }
    }
  }
}
