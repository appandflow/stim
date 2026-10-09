import StimKit
import StimStores
import SwiftUI

struct BuildSheetSelection: Identifiable, Equatable {
  var workspace: String
  var platform: String
  var run: String? = nil
  var id: String { "\(workspace)|\(platform)|\(run ?? "")" }
}

struct BuildSheet: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var selection: BuildSheetSelection
  var archive: ArchivedWorkspace?
  var logsExpired: Bool
  var readsServer: Bool
  var page: WorktreePage?
  var openAppLogs: ((Workspace, LogQuery) -> Void)?
  var openLogs: (LogQuery) -> Void
  #if DEBUG
    @Environment(\.fixtureDate) private var fixtureDate
  #else
    private var fixtureDate: Date? { nil }
  #endif
  @EnvironmentObject private var checks: BuildPlanChecks
  @EnvironmentObject private var actions: ActionCenter
  @Environment(\.dismiss) private var dismiss
  @State private var nativePlatform: String
  @State private var selectedEntry: WorktreePage.Entry
  @State private var selectedRun: String?

  init(
    cli: Task<StimCLI, Never>, env: Workspace, selection: BuildSheetSelection, page: WorktreePage? = nil,
    openLogs: @escaping (LogQuery) -> Void, openAppLogs: ((Workspace, LogQuery) -> Void)? = nil,
    archive: ArchivedWorkspace? = nil, logsExpired: Bool = false, readsServer: Bool = true
  ) {
    self.archive = archive
    self.logsExpired = logsExpired
    self.readsServer = readsServer
    self.cli = cli
    self.env = env
    self.selection = selection
    self.page = page
    self.openAppLogs = openAppLogs
    self.openLogs = openLogs
    _nativePlatform = State(initialValue: selection.platform)
    _selectedEntry = State(initialValue: WorktreePage.Entry(path: selection.workspace, platform: selection.platform))
    _selectedRun = State(initialValue: selection.run)
  }

  private var app: Workspace { page?.apps.first { $0.path == selectedEntry.path } ?? env }
  private var platform: String { page == nil ? nativePlatform : selectedEntry.platform }
  private var isMacos: Bool { platform == "macos" }

  private var running: Build? { app.build.flatMap { $0.isRunning ? $0 : nil } }
  private var platforms: [String] {
    ["ios", "android", "macos"].filter {
      app.runPlatforms.contains($0) || running?.platform == $0 || !history($0).isEmpty || $0 == platform
    }
  }
  private func history(_ platform: String) -> [BuildHistoryEntry] { app.builds?.builds(for: platform) ?? [] }
  private var runs: [BuildRun] {
    BuildRun.runs(platform: platform, running: running, history: history(platform), last: app.lastBuilds?.build(for: platform))
  }
  private var run: BuildRun? { runs.first { $0.id == selectedRun } ?? runs.first }
  private var entry: BuildPlanChecks.Entry? { checks.entry(workspace: app.path, platform: platform) }
  private var lastBuild: LastBuild? { app.lastBuilds?.build(for: platform) ?? history(platform).first?.build }
  private var buildKey: String { lastBuild?.planKey ?? "" }
  private var finishedAt: Date? { lastBuild.flatMap { $0.finishedAt == nil ? nil : $0.endedAt } }
  private var lastFailed: Bool {
    isMacos ? history("macos").first?.result == "failed" : app.lastBuilds?.build(for: platform)?.status == "failed"
  }
  private var busy: Bool { running != nil || actions.active(for: app.path) != nil }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      HStack(alignment: .top, spacing: 0) {
        recentBuilds.frame(width: 250)
        Divider()
        ScrollView {
          if let run {
            BuildRunDetail(
              cli: cli, env: app, run: run, archive: archive, logsExpired: logsExpired, readsServer: readsServer,
              dismiss: { dismiss() }
            )
            .id(page == nil ? run.id : "\(app.path)|\(run.id)")
            .padding(Space.xxl)
            if archive == nil, run.running == nil, run.id == runs.first?.id { nextBuild }
          } else {
            EmptyState(
              title: "No \(platformName(platform)) Build Recorded",
              message: archive == nil ? "Run the app to record a build." : "No build retained for this archive."
            )
            .padding(Space.xxl)
            if archive == nil { nextBuild }
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .font(.stim(.callout))
    .background(Palette.background)
    .frame(minWidth: 980, idealWidth: 980, minHeight: 720, idealHeight: 720)
    .task(id: (page == nil ? "" : app.path + "|") + "\(platform)|\(buildKey)|\(running?.key ?? "idle")") {
      guard archive == nil else { return }
      while !Task.isCancelled {
        if running == nil, actions.active(for: app.path) == nil {
          checks.check(
            workspace: app.path, builds: [platform: buildKey],
            finishedAt: finishedAt.map { [platform: $0] } ?? [:])
        } else {
          checks.cancel(workspace: app.path, platforms: page == nil ? ["ios", "android", "macos"] : [platform])
        }
        try? await Task.sleep(for: .seconds(30))
      }
    }
    .onAppear { selectedRun = run?.id }
    .onChange(of: nativePlatform) { selectedRun = runs.first?.id }
    .onChange(of: selectedEntry) { selectedRun = runs.first?.id }
    .onChange(of: runs.map(\.id)) {
      if !runs.contains(where: { $0.id == selectedRun }) { selectedRun = runs.first?.id }
    }
  }

  private func revealLogs(_ query: LogQuery) {
    if let openAppLogs { openAppLogs(app, query) } else { openLogs(query) }
  }

  private var nextBuild: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: "Next build")
      if running != nil {
        Text("Checked after the running build").foregroundStyle(Palette.tertiary)
      } else {
        NextBuildView(entry: entry, inlineDetails: true, recentBuildAt: finishedAt)
      }
    }
    .padding([.horizontal, .bottom], Space.xxl)
  }

  private var header: some View {
    HStack(spacing: Space.lg) {
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text("Build").font(.stim(.title, weight: .semibold))
        Text(app.names.title).foregroundStyle(Palette.secondary).lineLimit(1)
      }
      if let page {
        let entries = page.buildEntries
        let titles = entries.map { entry in
          platformName(entry.platform) + (page.subtitle(for: entry, among: entries).map { " \u{00B7} " + $0 } ?? "")
        }
        if !entries.isEmpty {
          HStack(spacing: Space.sm) {
            ForEach(Array(zip(entries, titles)), id: \.0) { entry, title in
              Button {
                selectedEntry = entry
              } label: {
                Pill(tone: entry == selectedEntry ? .brand : .neutral, outlined: entry != selectedEntry) { Text(title) }
              }
              .buttonStyle(.hoverRow())
              .accessibilityAddTraits(entry == selectedEntry ? .isSelected : [])
            }
          }
          .fixedSize()
        }
      } else if platforms.count > 1 {
        HStack(spacing: Space.sm) {
          ForEach(platforms, id: \.self) { platform in
            Button {
              nativePlatform = platform
            } label: {
              Pill(tone: platform == nativePlatform ? .brand : .neutral, outlined: platform != nativePlatform) {
                Text(platformName(platform))
              }
            }
            .buttonStyle(.hoverRow())
            .accessibilityAddTraits(platform == nativePlatform ? .isSelected : [])
          }
        }
        .fixedSize()
      }
      Spacer(minLength: Space.sm)
      if archive == nil {
        Button {
          if let macos = app.macos, isMacos {
            actions.run(
              "Build \(macos.product)", steps: [StimCommand(macos.runArguments, cwd: app.path)], present: false)
          } else {
            actions.runApp(app, platform: platform)
          }
        } label: {
          Label(lastFailed ? "Rebuild" : "Run", systemImage: "play.fill")
        }
        .buttonStyle(.stim(.primary))
        .disabled(busy)
        .help(
          isMacos
            ? "stim macos: builds the Swift package and launches the app"
            : "stim \(platform): the default slot and configuration; builds if needed, installs and launches"
        )
      }
      Button("Open in Logs Panel") {
        if let query = run.flatMap({
          LogQuery.build(platform: platform, slot: $0.slot, startedAt: $0.startedAt, finishedAt: $0.finishedAt)
        }) {
          dismiss()
          revealLogs(query)
        }
      }
      .buttonStyle(.stim())
      .disabled(logsExpired || !readsServer || run == nil || run?.startedDate == nil)
      Button("Done") { dismiss() }
        .buttonStyle(.stim())
        .keyboardShortcut(.cancelAction)
    }
    .padding(Space.xxl)
  }

  private var recentBuilds: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: "Recent builds").padding(.horizontal, Space.lg)
      ScrollView {
        TimelineView(running.map { .buildSeconds($0) } ?? .periodic(from: .now, by: 30)) { context in
          VStack(spacing: Space.xxs) {
            ForEach(runs) { run in
              Button {
                selectedRun = run.id
              } label: {
                VStack(alignment: .leading, spacing: Space.xs) {
                  HStack(spacing: Space.sm) {
                    if run.running != nil {
                      ProgressView().controlSize(.mini)
                    } else {
                      StatusDot(color: run.result == "succeeded" ? Palette.success : Color(run.tone), size: 6)
                    }
                    Text(run.outcome).lineLimit(1)
                    Spacer(minLength: 0)
                  }
                  HStack(spacing: Space.sm) {
                    Text(
                      run.running.map { Format.clock(ms: $0.progress(at: context.date).elapsedMs) }
                        ?? run.durationMs.map { Format.elapsed(ms: $0) } ?? ""
                    )
                    .monospacedDigit()
                    if let date = run.last?.endedAt ?? run.startedDate {
                      Text(Format.age((fixtureDate ?? context.date).timeIntervalSince(date)))
                    }
                  }
                  .font(.stim(.caption)).foregroundStyle(Palette.tertiary)
                  if run.slot != DeviceRef.defaultSlot {
                    Text("slot \(run.slot)").font(.stim(.caption)).foregroundStyle(Palette.secondary)
                  }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Space.md)
                .contentShape(Rectangle())
              }
              .buttonStyle(.hoverRow(radius: Radius.control, selected: run.id == self.run?.id))
              .accessibilityAddTraits(run.id == self.run?.id ? .isSelected : [])
            }
          }
          .padding(.horizontal, Space.sm)
        }
      }
    }
    .padding(.top, Space.xxl)
    .frame(maxHeight: .infinity)
  }
}

private struct BuildRunDetail: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var run: BuildRun
  var archive: ArchivedWorkspace?
  var logsExpired: Bool
  var readsServer: Bool
  var dismiss: () -> Void
  @State private var query: LogQuery?

  init(
    cli: Task<StimCLI, Never>, env: Workspace, run: BuildRun, archive: ArchivedWorkspace?, logsExpired: Bool, readsServer: Bool,
    dismiss: @escaping () -> Void
  ) {
    self.cli = cli
    self.env = env
    self.run = run
    self.archive = archive
    self.logsExpired = logsExpired
    self.readsServer = readsServer
    self.dismiss = dismiss
    _query = State(
      initialValue: .build(platform: run.platform, slot: run.slot, startedAt: run.startedAt, finishedAt: run.finishedAt))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xxl) {
      title
      section("Where it ran") {
        TimelineView(run.running.map { .buildSeconds($0) } ?? .periodic(from: .now, by: 30)) { context in
          let remote = run.running?.remote(at: context.date)
          Label(
            remote.map { "Building on \($0.host), \($0.phase)" }
              ?? run.offloadedTo.map { "Built on \(machineName($0))" } ?? "This Mac", systemImage: "desktopcomputer")
        }
        if let last = run.last { OffloadFallbackLine(build: last, inlineReason: true) }
      }
      if let build = run.running {
        section("Phases") {
          TimelineView(.buildSeconds(build)) { context in
            let steps = build.phaseSteps(history: env.builds?.builds(for: run.platform) ?? [], now: context.date)
            VStack(alignment: .leading, spacing: Space.md) {
              PhaseBar(steps: barSteps(steps), key: build.key)
              PhaseChecklist(steps: steps, cacheOutcome: build.cacheLookupOutcome)
            }
          }
          if build.phase == "compile", let line = build.detail?.line {
            Text(line).foregroundStyle(Palette.secondary).textSelection(.enabled)
          }
          if build.phase == "wait", let holder = build.waitingOn {
            WaitingOnButton(path: holder.path, current: env.path, beforeOpen: dismiss)
          }
          if build.waitingFor != nil { SlotWaitText(build: build) }
        }
      } else if let entry = run.history, !entry.finishedSteps.isEmpty {
        section("Phases") {
          PhaseChecklist(
            steps: entry.finishedSteps, cacheOutcome: nil, stoppedPhase: entry.stoppedPhase, failedPhase: entry.failedPhase)
        }
      }
      if cacheLabel != nil || run.missReason != nil || run.running?.recheckNote != nil {
        section("Cache") {
          if let cacheLabel {
            Pill(
              cacheLabel,
              tone: run.running?.cacheLookupOutcome == "hit" || run.last?.cacheHit == .local || run.last?.cacheHit == .remote
                ? .success : .warning
            )
          }
          if let reason = run.missReason { MissReasonView(reason: reason) }
          if let note = run.running?.recheckNote { Text(note).foregroundStyle(Palette.tertiary) }
        }
      }
      if ["failed", "cancelled", "interrupted"].contains(run.result) {
        section("Failure") {
          if let code = run.errorCode {
            Text(code).font(.stim(.callout, mono: true)).foregroundStyle(Palette.error).textSelection(.enabled)
          }
          if run.isMacos, let build = env.macos?.build, build.startedAt == run.startedAt, let message = build.error {
            Text(message).foregroundStyle(Palette.error).textSelection(.enabled)
          }
          if !run.diagnostics.isEmpty {
            BuildDiagnosticsView(diagnostics: run.diagnostics, workspace: env.path, initiallyExpanded: true)
          }
          if run.result == "interrupted" {
            Text("The run ended without recording a result; the next run in this workspace recorded it.")
              .foregroundStyle(Palette.secondary).textSelection(.enabled)
          }
          if query != nil {
            Toggle("Show errors", isOn: Binding(get: { query?.errorsOnly ?? false }, set: { query?.errorsOnly = $0 }))
              .toggleStyle(.checkbox)
          }
        }
      } else if !run.diagnostics.isEmpty {
        section("Diagnostics") {
          BuildDiagnosticsView(diagnostics: run.diagnostics, workspace: env.path, initiallyExpanded: true)
        }
      }
      if query != nil {
        section("Output") {
          if logsExpired {
            InlineEmpty("Logs expired")
          } else if !readsServer {
            InlineEmpty("Archived logs are read through stim-server.")
          } else {
            LogsView(
              cli: cli, env: archive == nil ? env : nil, query: Binding(get: { query! }, set: { query = $0 }),
              moment: .constant(nil), archive: archive,
              availableSources: LogSource.allCases.filter { !run.isMacos || $0 != .metro }
            )
            .id(run.id)
            .frame(height: 320)
            .clipShape(RoundedRectangle(cornerRadius: Radius.control))
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .onChange(of: run.finishedAt) { query?.buildRun?.finishedAt = run.finishedDate }
  }

  private var cacheLabel: String? {
    if let build = run.running {
      return build.cacheLookupOutcome.map { $0 == "hit" ? "Cache hit" : "Cache miss" }
    }
    guard !run.isMacos, let last = run.last, last.cacheSkipped != true else { return nil }
    switch last.cacheHit {
    case .local: return "Cache hit (local)"
    case .remote: return "Cache hit (remote)"
    case .none: return "Cache miss"
    }
  }

  private var title: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack(alignment: .firstTextBaseline, spacing: Space.md) {
        Label {
          Text(platformName(run.platform)).font(.stim(.headline))
        } icon: {
          PlatformGlyph(platform: run.platform, size: 13, color: Palette.text)
        }
        Pill(run.pillLabel, tone: run.tone)
        if let build = run.running {
          let (phase, counts) = build.currentPhaseLabel
          Text([phase, counts].compactMap { $0 }.joined(separator: " "))
            .font(.stim(.headline)).foregroundStyle(Palette.primary)
        } else {
          Text(run.summary)
            .font(.stim(.headline))
        }
      }
      if let build = run.running {
        TimelineView(.buildSeconds(build)) { context in
          let elapsedMs = build.progress(at: context.date).elapsedMs
          (Text(Format.clock(ms: elapsedMs))
            + Text(Format.estimateSuffix(elapsedMs: elapsedMs, expectedMs: build.expectedMs)).foregroundStyle(Palette.tertiary))
            .font(.stim(.title)).monospacedDigit()
        }
      }
      Text(facts).font(.stim(.footnote)).foregroundStyle(Palette.tertiary).textSelection(.enabled)
    }
  }

  private var facts: String {
    var parts: [String] = []
    if let date = run.startedDate { parts.append("Started \(date.formatted(date: .numeric, time: .standard))") }
    if let date = run.finishedDate {
      let sameDay = run.startedDate.map { Calendar.current.isDate($0, inSameDayAs: date) } ?? false
      parts.append("finished \(date.formatted(date: sameDay ? .omitted : .numeric, time: .standard))")
    }
    if run.slot != DeviceRef.defaultSlot { parts.append("slot \(run.slot)") }
    if let configuration = run.configurationLabel { parts.append(configuration) }
    if run.isMacos, let product = env.macos?.product { parts.append(product) }
    if let fingerprint = run.last?.fingerprint { parts.append("fingerprint \(fingerprint.prefix(8))") }
    return parts.joined(separator: " \u{00B7} ")
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: title)
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
