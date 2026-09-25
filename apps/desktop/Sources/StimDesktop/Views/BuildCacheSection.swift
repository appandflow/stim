import StimKit
import SwiftUI

/// Each platform's last build and what `stim <platform> --plan` predicts for the next one. Opening the
/// section checks every platform with a last build or a device, unless a build is running.
struct BuildCacheSection: View {
  var env: Workspace
  @EnvironmentObject private var checks: BuildPlanChecks

  private var used: Set<String> {
    Set(env.devices.map(\.platform)).union(["ios", "android"].filter { env.lastBuilds?.build(for: $0) != nil })
  }

  private var platforms: [String] {
    let shown = ["ios", "android"].filter(used.contains)
    return shown.isEmpty ? ["ios", "android"] : shown
  }

  private var running: Build? { env.build.flatMap { $0.isRunning ? $0 : nil } }

  private func buildKey(_ platform: String) -> String { env.lastBuilds?.build(for: platform)?.planKey ?? "" }

  private var trigger: [String] {
    [running == nil ? "idle" : "building"] + ["ios", "android"].filter(used.contains).map(buildKey)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionLabel(title: "Builds")
      ForEach(platforms, id: \.self) { platform in
        card(platform)
      }
    }
    .onAppear(perform: checkUsed)
    .onChange(of: trigger) { checkUsed() }
    .onDisappear { checks.cancel(workspace: env.path) }
  }

  private func checkUsed() {
    if running != nil { return checks.cancel(workspace: env.path) }
    checks.check(workspace: env.path, builds: Dictionary(uniqueKeysWithValues: used.map { ($0, buildKey($0)) }))
  }

  private func card(_ platform: String) -> some View {
    let entry = checks.entry(workspace: env.path, platform: platform)
    return VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(platform == "ios" ? "iOS" : "Android").font(Theme.body(12, weight: .semibold))
        Spacer()
        Button {
          checks.check(workspace: env.path, builds: [platform: buildKey(platform)], force: true)
        } label: {
          Image(systemName: "arrow.clockwise").accessibilityLabel("Check the next build again")
        }
        .buttonStyle(.stim())
        .disabled(running != nil || entry?.state == .checking)
        .help("stim \(platform) --plan: fingerprint and look up the caches without building")
      }
      if let last = env.lastBuilds?.build(for: platform) {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          Text(
            "Last: \(last.summary)\(last.endedAt.map { " \u{00B7} \(formatAgo(context.date.timeIntervalSince($0)))" } ?? "")"
          )
          .foregroundStyle(last.status == "ok" ? Theme.secondary : Theme.error)
          .help(last.fingerprint.map { "Fingerprint \($0)" } ?? "")
        }
        if let reason = last.missReason {
          MissReasonButton(reason: reason)
        }
      } else {
        Text("No build recorded").foregroundStyle(Theme.tertiary)
      }
      if let running {
        if running.platform == platform {
          BuildProgressBar(build: running, compact: true)
        } else {
          Text("Next build: checked after the running build").foregroundStyle(Theme.tertiary)
        }
      } else {
        nextBuild(entry?.state)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
  }

  @ViewBuilder
  private func nextBuild(_ state: BuildPlanChecks.State?) -> some View {
    switch state {
    case .checking:
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        Text("Checking next build\u{2026}").foregroundStyle(Theme.tertiary)
      }
    case .done(.plan(let plan)):
      VStack(alignment: .leading, spacing: 2) {
        Text("Next build: \(plan.nextBuild)")
          .foregroundStyle(plan.refusal != nil || plan.cacheHit == .none ? Theme.warn : Theme.live)
          .help(plan.detail ?? "")
        if let refusal = plan.refusal {
          Text([refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " "))
            .foregroundStyle(Theme.secondary)
            .textSelection(.enabled)
        }
      }
    case .done(.refused(let refusal)):
      Text("Cannot plan: \([refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " "))")
        .foregroundStyle(Theme.warn)
        .textSelection(.enabled)
        .help(refusal.code)
    case .failed(let message):
      Text(message).foregroundStyle(Theme.error)
    case nil:
      EmptyView()
    }
  }
}

private struct MissReasonButton: View {
  var reason: BuildMissReason
  @State private var shown = false

  var body: some View {
    Button {
      shown.toggle()
    } label: {
      HStack(spacing: 4) {
        Text("Why: \(reason.summary)").lineLimit(1).truncationMode(.tail)
        Image(systemName: "info.circle")
      }
      .foregroundStyle(Theme.warn)
    }
    .buttonStyle(.plain)
    .help("Why this build missed the cache")
    .popover(isPresented: $shown, arrowEdge: .bottom) {
      VStack(alignment: .leading, spacing: 8) {
        Text(reason.summary).font(Theme.body(13, weight: .semibold)).textSelection(.enabled)
        if let line = reason.baselineLine {
          Text(line).foregroundStyle(Theme.secondary)
        }
        if !reason.changes.isEmpty {
          VStack(alignment: .leading, spacing: 3) {
            ForEach(reason.changes, id: \.self) { change in
              HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(change.change == "added" ? "+" : change.change == "removed" ? "\u{2212}" : "~")
                  .foregroundStyle(
                    change.change == "added" ? Theme.live : change.change == "removed" ? Theme.error : Theme.warn)
                Text(change.source).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
              }
            }
          }
        }
        if reason.changeCount > reason.changes.count {
          let hidden = reason.changeCount - reason.changes.count
          Text(hidden == 1 ? "1 more source changed." : "\(hidden) more sources changed.")
            .foregroundStyle(Theme.tertiary)
        }
      }
      .padding(14)
      .frame(width: 380, alignment: .leading)
    }
  }
}

struct BuildOutcomeBadge: View {
  var build: Build

  var body: some View {
    if let label = build.outcomeLabel {
      Text(label)
        .font(Theme.body(10.5, weight: .semibold))
        .foregroundStyle(build.outcome == "hit" ? Theme.live : Theme.warn)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill((build.outcome == "hit" ? Theme.live : Theme.warn).opacity(0.14)))
        .lineLimit(1)
    }
  }
}
