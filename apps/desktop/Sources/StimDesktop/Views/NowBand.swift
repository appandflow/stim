import StimKit
import StimStores
import SwiftUI

/// What uses the Mac's CPU and memory now, from the status watch's `machine` section.
struct NowBand: View {
  @ObservedObject var status: StatusStore
  var metrics: MetricsStore
  var gc: GcReportStore
  @EnvironmentObject private var actions: ActionCenter
  @State private var reclaiming: (title: String, offer: GcReport.MemoryReclaim)?

  private static let valueWidth: CGFloat = 64
  private static let actionWidth: CGFloat = 88
  private static let reclaimWidth: CGFloat = 140

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Now").font(.stim(.headline))
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: Space.md) { tiles }
        VStack(spacing: Space.md) { tiles }
      }
      if let machine = status.payload?.machine, !machine.owners.isEmpty {
        let actionWidth = actionWidth(machine.owners)
        CollapsibleSection("machine.processes", title: "Processes", items: machine.ranked) { shown in
          Text(
            machine.memorySource == .footprint
              ? "Each process counts in one row. Memory is each process's footprint, as Activity Monitor shows it."
              : "Each process counts in one row. Resident memory counts memory shared between processes once per process, so simulators read high."
          )
          .font(.stim(.footnote))
          .foregroundStyle(Palette.tertiary)
          VStack(alignment: .leading, spacing: Space.xs) {
            header(actionWidth: actionWidth)
            ListSection(data: shown, id: \.key) {
              EmptyView()
            } row: { owner in
              row(owner, actionWidth: actionWidth)
            }
          }
        }
      } else if status.payload == nil {
        Text("Waiting for stim status...")
          .font(.stim(.callout))
          .foregroundStyle(Palette.secondary)
      } else if status.payload?.environments.contains(where: { $0.live || $0.build?.isRunning == true }) == true {
        Text("Live usage is unavailable: this stim does not report it, or it could not read the process table.")
          .font(.stim(.callout))
          .foregroundStyle(Palette.secondary)
      } else {
        Text("No simulator, emulator, dev server or build is running.")
          .font(.stim(.callout))
          .foregroundStyle(Palette.secondary)
      }
    }
    .confirmationDialog(
      "Reclaim memory?", isPresented: Binding(get: { reclaiming != nil }, set: { if !$0 { reclaiming = nil } }),
      titleVisibility: .visible, presenting: reclaiming
    ) { item in
      Button("Run stim gc --delete --cache \(item.offer.cacheKind)", role: .destructive) {
        actions.run(
          "Reclaim \(item.title) memory", item.offer.command(cwd: NSHomeDirectory()), key: ActionCenter.machineKey)
      }
    } message: { item in
      Text(item.offer.consequence)
    }
  }

  private func actionWidth(_ owners: [MachineOwner]) -> CGFloat {
    if owners.contains(where: { GcReport.reclaim(for: $0, in: gc.report) != nil }) { return Self.reclaimWidth }
    return owners.contains { $0.stopCommand != nil } ? Self.actionWidth : 0
  }

  @ViewBuilder private var tiles: some View {
    tile(
      "memorychip", "Memory used",
      metrics.memory.map { "\(Format.memory($0.usedBytes)) of \(Format.memory($0.totalBytes))" } ?? "\u{2014}",
      values: metrics.memoryUsed, peak: Double(metrics.memory?.totalBytes ?? 1))
    tile(
      "cpu", "Mac CPU used by the rows below",
      metrics.ownersCpu.last.map(formatPercent) ?? "\u{2014}",
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
      if actionWidth > 0 { Color.clear.frame(width: actionWidth, height: 1) }
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
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(owner.name).font(.stim(.body, weight: .semibold)).lineLimit(1)
        Text(ownerLine(owner)).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1)
        if let reason = GcReport.reclaim(for: owner, in: gc.report)?.unavailableReason {
          Text(abbreviatingHome(reason))
            .font(.stim(.caption))
            .foregroundStyle(Palette.tertiary)
            .lineLimit(2)
            .help(abbreviatingHome(reason))
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Text(formatPercent(owner.cpuPercent))
        .monospacedDigit()
        .frame(width: Self.valueWidth, alignment: .trailing)
      Text(Format.memory(Int64(owner.memory) * 1_048_576))
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
      .accessibilityLabel(
        owner.kind == .metro
          ? "\(title) \(status.names(ofPath: workspace).title)"
          : "\(title) \(owner.name), \(status.names(ofPath: workspace).title)"
      )
      .help(
        owner.kind == .metro
          ? "stim stop: stops this workspace's dev server and its devices"
          : "stim stop --slot \(owner.slot ?? "default"): stops every device in this slot, keeping the shared server and other slots running"
      )
    } else if let offer = GcReport.reclaim(for: owner, in: gc.report) {
      Button(offer.title) { reclaiming = (owner.name, offer) }
        .buttonStyle(.stim())
        .fixedSize()
        .disabled(!offer.isAvailable || actions.active(for: ActionCenter.machineKey) != nil)
        .help(
          offer.unavailableReason.map { abbreviatingHome($0) }
            ?? "stim gc --delete --cache \(offer.cacheKind): stops only what gc proves unused")
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
