import StimKit
import SwiftUI

/// Each platform's last build and, on request, what `stim <platform> --plan` predicts for the next one.
struct BuildCacheSection: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  @State private var checks: [String: Check] = [:]

  private enum Check {
    case running
    case done(BuildPlanOutcome)
    case failed(String)
  }

  private var platforms: [String] {
    let used = Set(env.devices.map(\.platform)).union(
      ["ios", "android"].filter { env.lastBuilds?.build(for: $0) != nil })
    let shown = ["ios", "android"].filter(used.contains)
    return shown.isEmpty ? ["ios", "android"] : shown
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionLabel(title: "Builds")
      ForEach(platforms, id: \.self) { platform in
        card(platform)
      }
    }
  }

  private func card(_ platform: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(platform == "ios" ? "iOS" : "Android").font(Theme.body(12, weight: .semibold))
        Spacer()
        Button("Check next build") { check(platform) }
          .controlSize(.small)
          .disabled(isRunning(platform))
          .help("stim \(platform) --plan: fingerprint and look up the caches without building")
      }
      if let last = env.lastBuilds?.build(for: platform) {
        Text("Last: \(last.summary)")
          .foregroundStyle(last.status == "ok" ? Theme.secondary : Theme.error)
          .help(last.fingerprint.map { "Fingerprint \($0)" } ?? "")
      } else {
        Text("No build recorded").foregroundStyle(Theme.tertiary)
      }
      switch checks[platform] {
      case .running:
        HStack(spacing: 6) {
          ProgressView().controlSize(.mini)
          Text("Checking\u{2026}").foregroundStyle(Theme.secondary)
        }
      case .done(.plan(let plan)):
        VStack(alignment: .leading, spacing: 2) {
          Text("Next: \(plan.summary)")
            .foregroundStyle(plan.refusal != nil ? Theme.warn : plan.cacheHit == .none ? Theme.warn : Theme.live)
          if let expectation = plan.expectation {
            Text(expectation).foregroundStyle(Theme.secondary)
          }
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
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
  }

  private func isRunning(_ platform: String) -> Bool {
    if case .running = checks[platform] { return true }
    return false
  }

  private func check(_ platform: String) {
    let path = env.path
    checks[platform] = .running
    Task {
      let cli = await cli.value
      let result = await Task.detached { () -> Check in
        do {
          return .done(try cli.plan(platform: platform, workspace: path))
        } catch {
          return .failed(error.localizedDescription)
        }
      }.value
      checks[platform] = result
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
