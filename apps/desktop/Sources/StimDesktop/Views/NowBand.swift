import StimKit
import StimStores
import SwiftUI

struct MachineResourceSummary: View {
  var metrics: MetricsStore
  var volume: DiskVolume?
  var minimumFreeBytes: Int64?
  var compact: Bool

  var body: some View {
    let layout = compact ? AnyLayout(VStackLayout(spacing: Space.lg)) : AnyLayout(HStackLayout(spacing: Space.lg))
    layout {
      historyTile(
        "Memory",
        value: metrics.memory.map { "\(Format.memory($0.usedBytes)) / \(Format.memory($0.totalBytes))" } ?? "Unavailable",
        values: metrics.memoryUsed, peak: Double(metrics.memory?.totalBytes ?? 1))
      historyTile(
        "CPU \u{00B7} tracked processes", value: metrics.ownersCpu.last.map(formatPercent) ?? "Unavailable",
        values: metrics.ownersCpu, peak: 100)
      Card {
        VStack(alignment: .leading, spacing: Space.md) {
          Text("Disk available").font(.stim(.callout)).foregroundStyle(Palette.secondary)
          Text(volume.map { Format.fileSize($0.freeBytes) } ?? "Unavailable")
            .font(.stim(.title)).monospacedDigit()
            .foregroundStyle(isLow ? Palette.warning : Palette.text)
          if let volume, volume.totalBytes > 0 {
            ProgressView(value: min(1, max(0, Double(volume.freeBytes) / Double(volume.totalBytes))))
              .tint(isLow ? Palette.warning : Palette.primary)
              .accessibilityLabel("Available disk space")
              .accessibilityValue(
                "\(Format.fileSize(volume.freeBytes)) of \(Format.fileSize(volume.totalBytes)) on \(volume.name)")
          }
          Text(minimumFreeBytes.map { "\(Format.fileSize($0)) minimum free" } ?? "No minimum free space set")
            .font(.stim(.caption)).foregroundStyle(isLow ? Palette.warning : Palette.secondary)
        }
        .padding(Space.xl)
        .frame(maxWidth: .infinity, minHeight: 106, maxHeight: .infinity, alignment: .leading)
      }
    }
    .fixedSize(horizontal: false, vertical: true)
  }

  private var isLow: Bool {
    guard let volume, let minimumFreeBytes else { return false }
    return volume.freeBytes < minimumFreeBytes
  }

  private func historyTile(_ title: String, value: String, values: [Double], peak: Double) -> some View {
    Card {
      VStack(alignment: .leading, spacing: Space.md) {
        Text(title).font(.stim(.callout)).foregroundStyle(Palette.secondary)
        Text(value).font(.stim(.title)).monospacedDigit().minimumScaleFactor(0.8).lineLimit(1)
        Sparkline(values: values, minimumPeak: peak).frame(height: 28)
          .accessibilityElement(children: .ignore)
          .accessibilityAddTraits(.isImage)
          .accessibilityLabel(
            "\(title), recent history. " + (values.isEmpty ? "Unavailable" : "\(values.count) measurements, oldest to newest"))
      }
      .padding(Space.xl)
      .frame(maxWidth: .infinity, minHeight: 106, maxHeight: .infinity, alignment: .leading)
    }
  }
}

struct NowBand: View {
  @ObservedObject var status: StatusStore
  var gc: GcReportStore
  @EnvironmentObject private var actions: ActionCenter
  @State private var reclaiming: (title: String, offer: GcReport.MemoryReclaim)?
  @State private var showsAll = false
  @State private var showsMeasurementInfo = false

  private static let valueWidth: CGFloat = 64
  private static let actionWidth: CGFloat = 88
  private static let reclaimWidth: CGFloat = 140

  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: Space.lg) {
        HStack {
          Text(showsAll ? "Resource users" : "Top resource users").font(.stim(.headline))
          Spacer()
          Button {
            showsMeasurementInfo.toggle()
          } label: {
            Image(systemName: "info.circle").foregroundStyle(Palette.secondary)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("About resource measurements")
          .popover(isPresented: $showsMeasurementInfo) {
            VStack(alignment: .leading, spacing: Space.md) {
              Text("Resource measurements").font(.stim(.headline))
              Text(
                "The summary shows whole-Mac memory and the tracked groups' share of this Mac's CPU. Each row counts CPU against one core, where 100% is one full core. The rows do not add up to whole-Mac memory."
              )
              Text(
                status.payload?.machine?.memorySource == .footprint
                  ? "Each process counts in one row. Memory is its footprint, as Activity Monitor shows it."
                  : "Each process counts in one row. Resident memory counts shared memory once per process, so simulators read high."
              )
            }
            .font(.stim(.callout))
            .padding(Space.xl)
            .frame(width: 320)
            .fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(.horizontal, Space.xl)
        if let machine = status.payload?.machine, !machine.owners.isEmpty {
          let actionWidth = actionWidth(machine.owners)
          let shown = showsAll ? machine.ranked[...] : machine.ranked.prefix(3)
          VStack(alignment: .leading, spacing: 0) {
            header(actionWidth: actionWidth)
              .padding(.bottom, Space.md)
            ForEach(shown, id: \.key) { owner in
              Divider().padding(.horizontal, Space.xl)
              row(owner, actionWidth: actionWidth)
            }
          }
          if machine.owners.count > 3 {
            Button(showsAll ? "Show fewer processes" : "View all \(machine.owners.count) processes") { showsAll.toggle() }
              .buttonStyle(.plain)
              .foregroundStyle(Palette.primary)
              .font(.stim(.callout))
              .padding(.horizontal, Space.xl)
          }
        } else if status.payload == nil {
          Text("Waiting for stim status...")
            .font(.stim(.callout))
            .foregroundStyle(Palette.secondary)
            .padding(.horizontal, Space.xl)
        } else if status.payload?.environments.contains(where: { $0.live || $0.build?.isRunning == true }) == true {
          Text("Live usage is unavailable: this stim does not report it, or it could not read the process table.")
            .font(.stim(.callout))
            .foregroundStyle(Palette.secondary)
            .padding(.horizontal, Space.xl)
        } else {
          Text("No simulator, emulator, dev server or build is running.")
            .font(.stim(.callout))
            .foregroundStyle(Palette.secondary)
            .padding(.horizontal, Space.xl)
        }
      }
      .padding(.vertical, Space.xl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .confirmationDialog(
      "Reclaim Memory?", isPresented: Binding(get: { reclaiming != nil }, set: { if !$0 { reclaiming = nil } }),
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

  private func header(actionWidth: CGFloat) -> some View {
    HStack(spacing: Space.md) {
      Text("Process group").frame(maxWidth: .infinity, alignment: .leading)
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
        .accessibilityLabel("CPU, \(formatPercent(owner.cpuPercent))")
        .monospacedDigit()
        .frame(width: Self.valueWidth, alignment: .trailing)
      Text(Format.memory(Int64(owner.memory) * 1_048_576))
        .accessibilityLabel("Memory, \(Format.memory(Int64(owner.memory) * 1_048_576))")
        .monospacedDigit()
        .frame(width: Self.valueWidth, alignment: .trailing)
      if actionWidth > 0 { action(owner).frame(width: actionWidth, alignment: .trailing) }
    }
  }

  @ViewBuilder private func action(_ owner: MachineOwner) -> some View {
    if let command = owner.stopCommand, let title = owner.stopTitle, let workspace = owner.workspace {
      Button(title) {
        actions.run(
          "\(title) \(owner.kind == .metro ? status.names(ofPath: workspace).title : owner.name)", steps: [command],
          present: false)
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
