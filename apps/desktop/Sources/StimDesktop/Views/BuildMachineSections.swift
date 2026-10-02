import StimKit
import SwiftUI

/// Where this Mac's compiling builds ran today and the latest placements with their reasons, from `stim stats`;
/// hidden while `offload.machines` names no machine or no build has compiled.
struct ThisMacPlacements: View {
  var model: BuildMachinesModel

  var body: some View {
    if !(model.entries ?? []).isEmpty, let offload = model.stats.value?.offload, !offload.placements.isEmpty {
      VStack(alignment: .leading, spacing: Space.md) {
        Text("Where builds ran").font(.stim(.headline))
        Text(
          "Today: \(offload.today.here) here, \(offload.today.offloaded) on a build machine, \(offload.today.fellBack) here after trying one."
        )
        .foregroundStyle(Palette.secondary)
        PlacementList(placements: Array(offload.placements.prefix(6)))
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

/// The selected build machine's readiness, capacity and build history from the page's minute refresh.
struct MachineBuildMachines: View {
  var model: BuildMachinesModel
  var checkout: String?
  var selectedMachine: String

  private var machines: [BuildMachineStatus] { model.check(in: checkout)?.statuses ?? [] }

  private var failure: String? {
    guard let problem = model.check(in: checkout)?.problem else { return nil }
    switch problem {
    case .unsupported: return "This stim does not report build machines; update it."
    case .failed(let message): return "Cannot check build machines: \(message)"
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xxxl) {
      if let failure {
        Text(failure).font(.stim(.footnote)).foregroundStyle(Palette.secondary).textSelection(.enabled)
      }
      if let machine = machines.first(where: { $0.machine == selectedMachine }) {
        section(machine)
      } else {
        MachineHeading(icon: "desktopcomputer", title: machineName(selectedMachine), subtitle: nil) {
          EmptyView()
        }
        Text(
          checkout == nil
            ? "Start a workspace with Stim to check this build machine."
            : model.isBusy ? "Checking build machine\u{2026}" : "No status reported for this machine yet."
        )
        .foregroundStyle(Palette.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func section(_ machine: BuildMachineStatus) -> some View {
    let ready = machine.readiness
    let offload = model.stats.value?.offload
    let counts = offload?.machines[machine.machine]
    let recent = Array((offload?.placements(for: machine.machine) ?? []).prefix(5))
    return VStack(alignment: .leading, spacing: Space.lg) {
      MachineHeading(
        icon: "desktopcomputer", title: machineName(machine.machine),
        subtitle: machine.capacity?.line.nilIfEmpty ?? machine.dnsName
      ) {
        Pill(ready.title, tone: ready.tone, size: .small).help(ready.reasons ?? machine.detail)
      }
      if ready.remedy != nil || machine.state != .approved {
        Text(machine.detail).foregroundStyle(Palette.secondary).textSelection(.enabled)
      }
      if let counts {
        HStack(alignment: .top, spacing: Space.md) {
          tile("Today", "\(counts.today.offloaded)", builds(counts.today))
          tile("All time", "\(counts.total.offloaded)", builds(counts.total))
          tile("Time saved", saved(counts.total.savedMs), "estimated against builds here")
          tile("Fell back", "\(counts.total.fallbacks)", "\(counts.today.fallbacks) today")
        }
      } else if offload != nil {
        Text("No build has gone to it yet.").foregroundStyle(Palette.tertiary)
      }
      if !recent.isEmpty { PlacementList(placements: recent) }
    }
  }

  private func builds(_ counts: BuildPlacements.Counts) -> String {
    let noun = counts.offloaded == 1 ? "build" : "builds"
    guard counts.offloaded > 0 else { return "\(noun) offloaded" }
    return "\(noun), \(Format.elapsed(ms: counts.offloadedMs / Double(counts.offloaded))) avg"
  }

  private func saved(_ ms: Double) -> String {
    if abs(ms) < 1000 { return "\u{2014}" }
    return ms > 0 ? Format.roundedDuration(ms: ms) : "\u{2212}\(Format.roundedDuration(ms: -ms))"
  }

  private func tile(_ title: String, _ value: String, _ caption: String) -> some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      Text(title).foregroundStyle(Palette.secondary)
      Text(value).font(.stim(.title))
      Text(caption).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
    }
    .padding(Space.lg)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
  }
}

/// A Mac's name with an icon, a detail line and trailing content, heading its section of the Machines page.
struct MachineHeading<Trailing: View>: View {
  var icon: String
  var title: String
  var subtitle: String?
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(alignment: .center, spacing: Space.md) {
      Image(systemName: icon).font(.stim(.headline)).foregroundStyle(Palette.tertiary).frame(width: 22)
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(spacing: Space.md) {
          Text(verbatim: title).font(.stim(.headline, weight: .semibold))
          trailing
        }
        if let subtitle { Text(subtitle).font(.stim(.footnote)).foregroundStyle(Palette.tertiary) }
      }
      Spacer()
    }
  }
}

/// Placements newest first: where each build ran, its platform and project, how long it took against this Mac's
/// estimate, and the reason Stim gave.
private struct PlacementList: View {
  var placements: [BuildPlacements.Placement]

  var body: some View {
    Card {
      VStack(spacing: 0) {
        ForEach(Array(placements.enumerated()), id: \.offset) { index, placement in
          if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
          row(placement)
        }
      }
    }
  }

  private func row(_ placement: BuildPlacements.Placement) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.lg) {
      Image(systemName: icon(placement.decision)).foregroundStyle(Color(tone(placement))).frame(width: 16)
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(spacing: Space.sm) {
          Text(placement.title).font(.stim(.callout, weight: .medium))
          Text("\(placement.platform == "ios" ? "iOS" : "Android") \u{00B7} \(lastComponent(placement.project))")
            .font(.stim(.footnote))
            .foregroundStyle(Palette.tertiary)
          if placement.failed == true { Pill("failed", tone: .error, size: .small) }
        }
        Text(placement.shortReason).font(.stim(.footnote)).foregroundStyle(Palette.secondary).textSelection(.enabled)
      }
      Spacer()
      VStack(alignment: .trailing, spacing: Space.xxs) {
        if let ms = placement.buildMs { Text(Format.elapsed(ms: ms)).font(.stim(.footnote, mono: true)) }
        if let estimate = placement.localEstimateMs, placement.decision == .offloaded {
          Text("~\(Format.elapsed(ms: estimate)) here").font(.stim(.caption)).foregroundStyle(Palette.tertiary)
        }
        Text(age(placement.at)).font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private func icon(_ decision: BuildPlacements.Placement.Decision) -> String {
    switch decision {
    case .offloaded: return "arrow.up.forward.circle"
    case .fellBack: return "arrow.uturn.backward.circle"
    case .here, .unknown: return "laptopcomputer"
    }
  }

  private func tone(_ placement: BuildPlacements.Placement) -> Tone {
    switch placement.decision {
    case .offloaded: return .brand
    case .fellBack: return .warning
    case .here, .unknown: return .tertiary
    }
  }

  private func lastComponent(_ path: String) -> String {
    (path as NSString).lastPathComponent
  }

  private func age(_ at: String) -> String {
    guard let date = try? Date(at, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true))
    else { return "" }
    return Format.age(Date().timeIntervalSince(date))
  }
}

extension String {
  fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
