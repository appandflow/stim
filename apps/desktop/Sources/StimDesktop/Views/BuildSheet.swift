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
  var page: WorktreePage?
  var openAppLogs: ((Workspace, LogQuery) -> Void)?
  var openLogs: (LogQuery) -> Void
  @EnvironmentObject private var checks: BuildPlanChecks
  @EnvironmentObject private var actions: ActionCenter
  @Environment(\.dismiss) private var dismiss
  @State private var nativePlatform: String
  @State private var selectedEntry: WorktreePage.Entry
  @State private var selectedRun: String?

  init(
    cli: Task<StimCLI, Never>, env: Workspace, selection: BuildSheetSelection, page: WorktreePage? = nil,
    openLogs: @escaping (LogQuery) -> Void, openAppLogs: ((Workspace, LogQuery) -> Void)? = nil
  ) {
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
  private var isMacos: Bool { page != nil && platform == "macos" }

  private var running: Build? { app.build.flatMap { $0.isRunning ? $0 : nil } }
  private var platforms: [String] {
    ["ios", "android"].filter {
      app.runPlatforms.contains($0) || running?.platform == $0 || !history($0).isEmpty || $0 == platform
    }
  }
  private func history(_ platform: String) -> [BuildHistoryEntry] { app.builds?.builds(for: platform) ?? [] }
  private var runs: [BuildRun] {
    BuildRun.runs(platform: platform, running: running, history: history(platform), last: app.lastBuilds?.build(for: platform))
  }
  private var run: BuildRun? { runs.first { $0.id == selectedRun } ?? runs.first }
  private var entry: BuildPlanChecks.Entry? { checks.entry(workspace: app.path, platform: platform) }
  private var buildKey: String { app.lastBuilds?.build(for: platform)?.planKey ?? "" }
  private var busy: Bool { running != nil || actions.active(for: app.path) != nil }

  var body: some View {
    VStack(spacing: 0) {
      if let page {
        Picker("Platform", selection: $selectedEntry) {
          ForEach(page.buildEntries) { entry in
            Text(
              platformName(entry.platform)
                + (page.subtitle(for: entry, among: page.buildEntries).map { " \u{00B7} " + $0 } ?? "")
            ).tag(entry)
          }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .padding([.horizontal, .top], Space.xxl)
      }
      header
      Divider()
      if isMacos {
        macosPanel
      } else {
        HStack(alignment: .top, spacing: 0) {
          recentBuilds.frame(width: 250)
          Divider()
          ScrollView {
            if let run {
              BuildRunDetail(cli: cli, env: app, run: run, dismiss: { dismiss() })
                .id(page == nil ? run.id : "\(app.path)|\(run.id)")
                .padding(Space.xxl)
              if run.running == nil, run.id == runs.first?.id { nextBuild }
            } else {
              EmptyState(title: "No \(platformName(platform)) build recorded", message: "Run the app to record a build.")
                .padding(Space.xxl)
              nextBuild
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
    .font(.stim(.callout))
    .background(Palette.background)
    .frame(minWidth: 980, idealWidth: 980, minHeight: 720, idealHeight: 720)
    .task(id: (page == nil ? "" : app.path + "|") + "\(platform)|\(buildKey)|\(running?.key ?? "idle")") {
      guard !isMacos else { return }
      if running == nil {
        checks.check(workspace: app.path, builds: [platform: buildKey])
      } else {
        checks.cancel(workspace: app.path, platforms: page == nil ? ["ios", "android"] : [platform])
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

  private var macosPanel: some View {
    ScrollView {
      if let macos = app.macos {
        VStack(alignment: .leading, spacing: Space.lg) {
          Text("macOS \(macos.product)").font(.stim(.title, weight: .semibold))
          Text("Swift Package Debug: \(macos.build.state)").foregroundStyle(Palette.secondary)
          if let duration = macos.build.durationMs {
            Text(Format.elapsed(ms: duration)).monospacedDigit().foregroundStyle(Palette.secondary)
          }
          if let error = macos.build.error {
            Text(error).foregroundStyle(Palette.error).textSelection(.enabled)
          }
          if let query = LogQuery.build(
            platform: "macos", slot: "default", startedAt: macos.build.startedAt, finishedAt: macos.build.finishedAt)
          {
            Button("Build logs") {
              dismiss()
              revealLogs(query)
            }.buttonStyle(.stim())
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.xxl)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var nextBuild: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack {
        SectionLabel(title: "Next build")
        Spacer()
        checkButton
      }
      if running != nil {
        Text("Checked after the running build").foregroundStyle(Palette.tertiary)
      } else {
        NextBuildView(entry: entry, inlineDetails: true)
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
      if page == nil, platforms.count > 1 {
        Picker("Platform", selection: $nativePlatform) {
          ForEach(platforms, id: \.self) { Text(platformName($0)).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 180)
      }
      Spacer(minLength: Space.sm)
      if !isMacos {
        Button {
          actions.runApp(app, platform: platform)
        } label: {
          Label(app.lastBuilds?.build(for: platform)?.status == "failed" ? "Rebuild" : "Run", systemImage: "play.fill")
        }
        .buttonStyle(.stim(.primary, .regular))
        .disabled(busy)
        .help("stim \(platform) with no options: the default slot and configuration; builds if needed, installs and launches")
        checkButton
        Button("Open in logs panel") {
          if let query = run.flatMap({
            LogQuery.build(platform: platform, slot: $0.slot, startedAt: $0.startedAt, finishedAt: $0.finishedAt)
          }) {
            dismiss()
            revealLogs(query)
          }
        }
        .buttonStyle(.stim())
        .disabled(run == nil || run?.startedDate == nil)
      }
      Button("Done") { dismiss() }
        .buttonStyle(.stim())
        .keyboardShortcut(.cancelAction)
    }
    .padding(Space.xxl)
  }

  private var checkButton: some View {
    Button {
      checks.check(workspace: app.path, builds: [platform: buildKey], force: true)
    } label: {
      Label("Check", systemImage: "magnifyingglass")
    }
    .buttonStyle(.stim())
    .disabled(busy || entry?.state == .checking)
    .help("stim \(platform) --plan: predict the next build from the fingerprint and caches, without building")
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
                      Circle().fill(run.result == "succeeded" ? Palette.success : Color(run.tone)).frame(width: 6, height: 6)
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
                      Text(Format.age(context.date.timeIntervalSince(date)))
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
  var dismiss: () -> Void
  @State private var query: LogQuery?

  init(cli: Task<StimCLI, Never>, env: Workspace, run: BuildRun, dismiss: @escaping () -> Void) {
    self.cli = cli
    self.env = env
    self.run = run
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
        }
      } else if let entry = run.history, !entry.finishedSteps.isEmpty {
        section("Phases") {
          PhaseChecklist(steps: entry.finishedSteps, cacheOutcome: nil, stoppedPhase: entry.stoppedPhase)
        }
      }
      if cacheLabel != nil || run.missReason != nil || run.running?.recheckNote != nil {
        section("Cache") {
          if let cacheLabel {
            Pill(
              cacheLabel,
              tone: run.running?.cacheLookupOutcome == "hit" || run.last?.cacheHit == .local || run.last?.cacheHit == .remote
                ? .success : .warning)
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
          LogsView(cli: cli, env: env, query: Binding(get: { query! }, set: { query = $0 }), moment: .constant(nil))
            .id(run.id)
            .frame(height: 320)
            .clipShape(RoundedRectangle(cornerRadius: Radius.control))
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
    guard let last = run.last, last.cacheSkipped != true else { return nil }
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
          Text(run.last?.summary ?? run.outcome)
            .font(.stim(.headline))
        }
      }
      if let build = run.running {
        TimelineView(.buildSeconds(build)) { context in
          (Text(Format.clock(ms: build.progress(at: context.date).elapsedMs))
            + Text(build.expectedMs.map { " / ~\(Format.clock(ms: $0))" } ?? "").foregroundStyle(Palette.tertiary))
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
    if let configuration = run.configuration { parts.append(configuration) }
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
