import StimKit
import SwiftUI

/// What uses the Mac's CPU and memory now, from the status watch's `machine` section.
struct NowBand: View {
  @ObservedObject var status: StatusStore
  @ObservedObject var metrics: MetricsStore
  @EnvironmentObject private var actions: ActionCenter

  private static let valueWidth: CGFloat = 64
  private static let actionWidth: CGFloat = 88

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Now").font(.stim(.headline))
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: Space.md) { tiles }
        VStack(spacing: Space.md) { tiles }
      }
      if let machine = status.payload?.machine, !machine.owners.isEmpty {
        let actionWidth = machine.owners.contains { $0.stopCommand != nil } ? Self.actionWidth : 0
        VStack(alignment: .leading, spacing: Space.xs) {
          header(actionWidth: actionWidth)
          ListSection(data: machine.ranked, id: \.key) { EmptyView() } row: { owner in
            row(owner, actionWidth: actionWidth)
          }
        }
        Text(
          "Each process counts in one row. Resident memory counts memory shared between processes once per process, so simulators read high."
        )
        .font(.stim(.footnote))
        .foregroundStyle(Palette.tertiary)
      } else if status.payload?.environments.contains(where: \.live) == true {
        Text("Live usage is unavailable: this stim does not report it, or it could not read the process table.")
          .font(.stim(.callout))
          .foregroundStyle(Palette.secondary)
      } else {
        Text("No simulator, emulator, dev server or build is running.")
          .font(.stim(.callout))
          .foregroundStyle(Palette.secondary)
      }
    }
  }

  @ViewBuilder private var tiles: some View {
    tile(
      "memorychip", "Memory used",
      metrics.memory.map { "\(formatMemory($0.usedBytes)) of \(formatMemory($0.totalBytes))" } ?? "--",
      values: metrics.memoryUsed, peak: Double(metrics.memory?.totalBytes ?? 1))
    tile(
      "cpu", "CPU of the rows below",
      status.payload?.machine.map { formatPercent($0.cpuPercent) } ?? "--",
      values: metrics.ownersCpu, peak: 100)
  }

  private func tile(_ icon: String, _ title: String, _ value: String, values: [Double], peak: Double) -> some View {
    Card {
      VStack(alignment: .leading, spacing: Space.sm) {
        Label(title, systemImage: icon).foregroundStyle(Palette.secondary)
        Text(value).font(.stim(.headline)).monospacedDigit()
        Sparkline(values: values, minimumPeak: peak).frame(height: 28)
      }
      .padding(Space.lg)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func header(actionWidth: CGFloat) -> some View {
    HStack(spacing: Space.md) {
      Text("What").frame(maxWidth: .infinity, alignment: .leading)
      Text("CPU").frame(width: Self.valueWidth, alignment: .trailing)
      Text("Memory").frame(width: Self.valueWidth, alignment: .trailing)
      Color.clear.frame(width: actionWidth, height: 1)
    }
    .font(.stim(.caption2, weight: .semibold))
    .foregroundStyle(Palette.tertiary)
    .padding(.horizontal, Space.xl)
  }

  private func row(_ owner: MachineOwner, actionWidth: CGFloat) -> some View {
    ListRow {
      Image(systemName: Self.icon(owner.kind))
        .foregroundStyle(owner.owned ? Palette.primary : Palette.tertiary)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(owner.name).font(.stim(.body, weight: .semibold)).lineLimit(1)
        Text(ownerLine(owner)).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Text(formatPercent(owner.cpuPercent))
        .monospacedDigit()
        .frame(width: Self.valueWidth, alignment: .trailing)
      Text(formatMemory(Int64(owner.residentMb) * 1_048_576))
        .monospacedDigit()
        .frame(width: Self.valueWidth, alignment: .trailing)
      if actionWidth > 0 { action(owner).frame(width: actionWidth, alignment: .trailing) }
    }
  }

  @ViewBuilder private func action(_ owner: MachineOwner) -> some View {
    if let command = owner.stopCommand, let title = owner.stopTitle, let workspace = owner.workspace {
      Button(title) {
        actions.run("\(title) \(owner.kind == .metro ? status.names(ofPath: workspace).title : owner.name)", command)
      }
      .buttonStyle(.stim(.destructive))
      .fixedSize()
      .disabled(actions.active(for: workspace) != nil)
      .help(
        owner.kind == .metro
          ? "stim stop: stops this workspace's dev server and its devices"
          : "stim stop --slot \(owner.slot ?? "default"): stops every device in this slot, keeping the shared server and other slots running")
    } else {
      Color.clear.frame(height: 1)
    }
  }

  private func ownerLine(_ owner: MachineOwner) -> String {
    let count = countLabel(owner.processes, "process", plural: "processes")
    if let workspace = owner.workspace {
      let slot = owner.slot.map { " \u{00B7} \($0)" } ?? ""
      return "\(status.names(ofPath: workspace).title)\(slot) \u{00B7} \(count)"
    }
    switch owner.kind {
    case .simulator, .emulator: return "Not Stim's \u{00B7} \(count)"
    case .server: return "Stim \u{00B7} \(count)"
    default: return "Shared by the machine \u{00B7} \(count)"
    }
  }

  private static func icon(_ kind: MachineOwner.Kind) -> String {
    switch kind {
    case .simulator: return "iphone"
    case .emulator: return "candybarphone"
    case .metro: return "shippingbox"
    case .build: return "hammer"
    case .browser: return "globe"
    case .server: return "network"
    case .shared, .other: return "gearshape.2"
    }
  }
}
