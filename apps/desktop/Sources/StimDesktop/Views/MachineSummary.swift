import StimKit
import StimStores
import SwiftUI

struct MachineSummary: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var gc: GcReportStore
  var width: CGFloat
  var measuresNarrowest = false
  var openMachine: () -> Void
  @State private var expandedResource: ResourceKind?

  @State private var hoveredResource: ResourceKind?
  @Namespace private var hoverNamespace
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private func hover(_ resource: ResourceKind) {
    withAnimation(reduceMotion || hoveredResource == nil ? nil : .spring(response: 0.25, dampingFraction: 0.87)) {
      hoveredResource = resource
    }
    if expandedResource != nil {
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) { expandedResource = resource }
    }
  }

  private func shows(_ resource: ResourceKind) -> Binding<Bool> {
    Binding(
      get: { expandedResource == resource },
      set: { if !$0, expandedResource == resource { expandedResource = nil } }
    )
  }

  @ViewBuilder private func popover(_ resource: ResourceKind) -> some View {
    switch resource {
    case .cpu: cpuPopover
    case .load: loadPopover
    case .memory: memoryPopover
    case .disk: DiskPopover(metrics: metrics, gc: gc, openMachine: openMachine).presentationBackground(Palette.surface)
    }
  }

  /// macOS 26 draws a glass capsule around a toolbar item even when it draws nothing, so the item is declared only when `row` has content.
  var hasContent: Bool {
    store.error != nil || showsCPU || showsLoad || showsMemory || metrics.hasVolumes
      || (!store.watching && store.updatedAt != nil)
  }

  var contentKey: String {
    "\(store.error != nil)\(showsCPU)\(showsLoad)\(showsMemory)\(metrics.hasVolumes)\(!store.watching && store.updatedAt != nil)"
  }

  private var showsCPU: Bool { metrics.machineCpuFraction != nil }
  private var workspacesCpu: String? { metrics.workspacesCpuFraction.map { formatPercent($0 * 100) } }
  private var showsLoad: Bool { store.payload?.capacity?.load != nil }
  private var showsMemory: Bool { store.payload?.capacity != nil && metrics.memory != nil }

  var body: some View {
    ProposedWidth(width: max(0, width)) {
      if measuresNarrowest {
        narrowestRow.fixedSize()
      } else {
        ViewThatFits(in: .horizontal) {
          row(showsCPU: true, showsLoad: true, showsMemory: true, showsBar: true, showsReclaimable: true)
          row(showsCPU: true, showsLoad: true, showsMemory: true, showsBar: true, showsReclaimable: false)
          row(showsCPU: true, showsLoad: true, showsMemory: true, showsBar: false, showsReclaimable: false)
          row(showsCPU: false, showsLoad: true, showsMemory: true, showsBar: false, showsReclaimable: false)
          narrowestRow
        }
      }
    }
    .font(.stim(.callout))
  }

  private var narrowestRow: some View {
    row(
      showsCPU: !metrics.hasVolumes, showsLoad: !metrics.hasVolumes, showsMemory: !metrics.hasVolumes, showsBar: false,
      showsReclaimable: false)
  }

  private func row(
    showsCPU includesCPU: Bool, showsLoad includesLoad: Bool, showsMemory: Bool, showsBar: Bool, showsReclaimable: Bool
  ) -> some View {
    HStack(spacing: Space.md) {
      if let error = store.error {
        Label(abbreviatingHome(error), systemImage: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
          .labelStyle(.titleAndIcon)
          .lineLimit(1)
          .frame(maxWidth: 220)
          .help(abbreviatingHome(error))
      }
      let cap = store.payload?.capacity
      let cpu = includesCPU ? metrics.machineCpuFraction : nil
      let load = includesLoad ? cap?.load : nil
      let memory = cap == nil || !showsMemory ? nil : metrics.memory
      let lowest = metrics.volumes.min(by: { $0.freeBytes < $1.freeBytes })
      ForEach(
        Array(
          ResourceSummary.entries(cpu: cpu != nil, load: load != nil, memory: memory != nil, disk: lowest != nil).enumerated()),
        id: \.offset
      ) { _, entry in
        switch entry {
        case .divider:
          Rectangle().fill(Palette.secondary.opacity(0.3)).frame(width: 1, height: 16)
        case .item(.cpu):
          if let cpu { cpuItem(cpu, load: load) }
        case .item(.load):
          if let load { loadItem(load) }
        case .item(.memory):
          if let memory, let cap { memoryItem(memory, cap: cap, showsBar: showsBar) }
        case .item(.disk):
          if let lowest { diskItem(lowest, showsReclaimable: showsReclaimable) }
        }
      }
      if !store.watching, let at = store.updatedAt {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text("\(max(0, Int(context.date.timeIntervalSince(at))))s ago")
            .font(.stim(.caption, mono: true))
            .foregroundStyle(Palette.tertiary)
            .help("Time since the last stim status refresh")
        }
      }
    }
    .padding(.horizontal, Space.lg)
    .padding(.vertical, Space.xs)
    .contentShape(Rectangle())
    .onHover { inside in
      if !inside { hoveredResource = nil }
    }
  }

  private func cpuItem(_ cpu: Double, load: CapacityLoad?) -> some View {
    let cpuText = formatPercent(cpu * 100)
    let cpuTone = UsageThresholds.cpu(fraction: cpu)
    var value = cpuText
    var tone = cpuTone
    var accessibilityLabel = "CPU details"
    var accessibilityValue = cpuText
    var help = "CPU is the share of this Mac's processor time in use right now, up to 100%."
    if let load {
      value = "\(cpuText) \u{00B7} \(load.text)"
      tone = UsageThresholds.worse(cpuTone, load.tone)
      accessibilityLabel = "CPU and load details"
      accessibilityValue = "CPU \(cpuText), load \(load.text)"
      help += " Load is the 5-minute average of tasks running or waiting, per core. \(load.busySentence)"
    }
    if let workspacesCpu {
      help += " Stim's share of CPU: active workspaces' processes, simulators and emulators use \(workspacesCpu)."
    }
    return Button {
      expandedResource = .cpu
    } label: {
      statItem(icon: ResourceKind.cpu.icon, label: "CPU", value: value, tone: tone)
        .padding(Space.sm)
    }
    .buttonStyle(ResourceHoverStyle(highlighted: hoveredResource == .cpu, namespace: hoverNamespace))
    .accessibilityLabel(accessibilityLabel)
    .accessibilityValue(accessibilityValue)
    .help(help)
    .popover(isPresented: shows(.cpu), arrowEdge: .bottom) { popover(.cpu) }
    .onHover { if $0 { hover(.cpu) } }
  }

  private func loadItem(_ load: CapacityLoad) -> some View {
    Button {
      expandedResource = .load
    } label: {
      statItem(icon: ResourceKind.load.icon, label: "Load", value: load.text, tone: load.tone)
        .padding(Space.sm)
    }
    .buttonStyle(ResourceHoverStyle(highlighted: hoveredResource == .load, namespace: hoverNamespace))
    .accessibilityLabel("Load details")
    .accessibilityValue(load.text)
    .help("Load is the 5-minute average of tasks running or waiting, per core. \(load.busySentence)")
    .popover(isPresented: shows(.load), arrowEdge: .bottom) { popover(.load) }
    .onHover { if $0 { hover(.load) } }
  }

  private func memoryItem(_ memory: MachineMemory, cap: Capacity, showsBar: Bool) -> some View {
    Button {
      expandedResource = .memory
    } label: {
      HStack(spacing: Space.sm) {
        statItem(
          icon: ResourceKind.memory.icon, label: "RAM",
          value: Format.memoryPair(usedBytes: memory.usedBytes, totalBytes: memory.totalBytes),
          tone: UsageThresholds.memory(memory.pressure))
        if showsBar {
          StimProgressBar(
            value: min(1, Double(memory.usedBytes) / Double(max(1, memory.totalBytes))),
            tint: Color(UsageThresholds.memory(memory.pressure))
          )
          .frame(width: 50)
        }
      }
      .padding(Space.sm)
    }
    .buttonStyle(ResourceHoverStyle(highlighted: hoveredResource == .memory, namespace: hoverNamespace))
    .accessibilityLabel("Memory details")
    .accessibilityValue(Format.memoryPair(usedBytes: memory.usedBytes, totalBytes: memory.totalBytes))
    .popover(isPresented: shows(.memory), arrowEdge: .bottom) { popover(.memory) }
    .onHover { if $0 { hover(.memory) } }
    .help(
      "Memory used on this Mac, as Activity Monitor counts it. Stim's share: active workspaces \(store.payload?.machine?.memorySource == .footprint ? "use" : "commit") \(Format.gigabytes(mb: cap.committedMb)) of \(Format.gigabytes(mb: cap.totalMemoryMb))."
    )
  }

  private func diskItem(_ lowest: DiskVolume, showsReclaimable: Bool) -> some View {
    Button {
      expandedResource = .disk
    } label: {
      HStack(spacing: Space.sm) {
        statItem(
          icon: ResourceKind.disk.icon, label: "Disk", value: "\(Format.fileSize(lowest.freeBytes)) free",
          tone: UsageThresholds.disk(freeBytes: lowest.freeBytes))
        if showsReclaimable, let reclaimable = gc.report?.reclaimable, reclaimable.bytes > 0 {
          Text("\u{00B7} \(Format.fileSize(reclaimable.bytes)) reclaimable").foregroundStyle(Palette.secondary)
        }
      }
      .padding(Space.sm)
    }
    .buttonStyle(ResourceHoverStyle(highlighted: hoveredResource == .disk, namespace: hoverNamespace))
    .accessibilityLabel("Disk details")
    .accessibilityValue("\(Format.fileSize(lowest.freeBytes)) free")
    .help("Free space on the fullest volume holding the repositories, Stim home or simulators, without purgeable space")
    .popover(isPresented: shows(.disk), arrowEdge: .bottom) { popover(.disk) }
    .onHover { if $0 { hover(.disk) } }
  }

  private var cpuPopover: some View {
    let load = store.payload?.capacity?.load
    return MachineResourcePopover(
      title: load == nil ? "CPU" : "CPU and load", icon: ResourceKind.cpu.icon, openMachine: openMachine
    ) {
      if let cpu = metrics.machineCpuFraction {
        if load != nil { SectionLabel(title: "CPU") }
        Text(formatPercent(cpu * 100)).font(.stim(.title)).monospacedDigit()
        Sparkline(values: metrics.machineCpu, minimumPeak: 100).frame(height: 48)
          .accessibilityLabel("CPU usage, recent history, oldest to newest")
        Text("CPU is how much of this Mac's processor time is in use right now. It tops out at 100%.")
          .foregroundStyle(Palette.secondary)
        if let workspacesCpu {
          Text(
            "Stim workspaces: \(workspacesCpu)"
              + " (\(countLabel(store.payload?.capacity?.liveCount ?? 0, "active workspace")))"
          )
          .foregroundStyle(Palette.secondary)
        }
      }
      if let load {
        Rectangle().fill(Palette.border).frame(height: 1)
        SectionLabel(title: "Load")
        loadDetails(load)
      }
    }
  }

  private var loadPopover: some View {
    MachineResourcePopover(title: "Load", icon: ResourceKind.load.icon, openMachine: openMachine) {
      if let load = store.payload?.capacity?.load { loadDetails(load) }
    }
  }

  @ViewBuilder private func loadDetails(_ load: CapacityLoad) -> some View {
    Text(load.text).font(.stim(.title)).foregroundStyle(Color(load.tone)).monospacedDigit()
    Text(
      "Load is how many tasks are running or waiting per core, averaged over 5 minutes. Above 1 per core, work queues up."
    )
    .foregroundStyle(Palette.secondary)
    Text(load.busySentence).foregroundStyle(Palette.secondary)
    if load.state != .free { Text(load.explanation).foregroundStyle(Palette.secondary) }
  }

  private var memoryPopover: some View {
    MachineResourcePopover(title: "Memory", icon: "memorychip", openMachine: openMachine) {
      if let memory = metrics.memory {
        Text("\(Format.memory(memory.usedBytes)) of \(Format.memory(memory.totalBytes))")
          .font(.stim(.headline)).monospacedDigit()
        Sparkline(values: metrics.memoryUsed, minimumPeak: Double(memory.totalBytes)).frame(height: 48)
        Text("Memory used on this Mac, as Activity Monitor counts it.").foregroundStyle(Palette.secondary)
        if let cap = store.payload?.capacity {
          Text(
            "Active workspaces \(store.payload?.machine?.memorySource == .footprint ? "use" : "commit") \(Format.gigabytes(mb: cap.committedMb))."
          )
          .foregroundStyle(Palette.secondary)
        }
      }
    }
  }

  private func statItem(icon: String, label: String, value: String, tone: Tone) -> some View {
    HStack(spacing: Space.sm) {
      Image(systemName: icon)
        .foregroundStyle(Palette.secondary)

      Text(label)
        .font(.stim(.caption))
        .foregroundStyle(Palette.secondary)

      Text(value)
        .font(.stim(.caption, mono: true))
        .fontWeight(.semibold)
        .foregroundStyle(Color(tone))
    }
    .fixedSize()
  }
}

/// macOS proposes no width to a toolbar item, so this proposes `width` to its content and takes the content's size.
private struct ProposedWidth: Layout {
  var width: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    subviews.first?.sizeThatFits(ProposedViewSize(width: width, height: proposal.height)) ?? .zero
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
  }
}

struct DiskPopover: View {
  var metrics: MetricsStore
  var gc: GcReportStore
  var openMachine: () -> Void

  var body: some View {
    let volumes = metrics.volumes
    let reclaimable = gc.report?.reclaimable
    MachineResourcePopover(title: "Disk", icon: "internaldrive", openMachine: openMachine) {
      ForEach(volumes) { volume in
        VStack(alignment: .leading, spacing: Space.sm) {
          HStack {
            Text(volume.name).font(.stim(.callout, weight: .semibold))
            Spacer()
            Text("\(Format.fileSize(volume.freeBytes)) free of \(Format.fileSize(volume.totalBytes))")
              .font(.stim(.caption, mono: true))
              .foregroundStyle(Palette.secondary)
          }
          Sparkline(values: metrics.diskUsed[volume.id] ?? [], minimumPeak: Double(volume.totalBytes))
            .frame(height: 48)
            .accessibilityLabel("\(volume.name) disk space used, recent history, oldest to newest")
          Text(volume.holds.joined(separator: ", ")).foregroundStyle(Palette.tertiary)
        }
      }
      Rectangle().fill(Palette.border).frame(height: 1)
      SectionLabel(title: "Reclaimable")
      if let reclaimable {
        if reclaimable.entries == 0 {
          Text("stim gc reports nothing to reclaim.").foregroundStyle(Palette.secondary)
        } else {
          Text(Format.fileSize(reclaimable.bytes)).font(.stim(.title)).foregroundStyle(Palette.primary)
          Text(
            "\(reclaimable.entries) \(reclaimable.entries == 1 ? "entry" : "entries")"
              + (reclaimable.unsized > 0 ? ", \(reclaimable.unsized) of unknown size" : "")
          )
          .foregroundStyle(Palette.secondary)
        }
        CommandText(command: "stim gc")
      } else {
        Text("Needs a stim version with gc --json.").foregroundStyle(Palette.secondary)
      }
    }
  }
}

private struct MachineResourcePopover<Content: View>: View {
  var title: String
  var icon: String
  var openMachine: () -> Void
  @ViewBuilder var content: Content
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      VStack(alignment: .leading, spacing: Space.xxs) {
        Label(title, systemImage: icon).font(.stim(.headline))
        Text("This Mac").font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
      content
      Rectangle().fill(Palette.border).frame(height: 1)
      Button("Open Machines", systemImage: "laptopcomputer") {
        dismiss()
        openMachine()
      }
      .buttonStyle(.stim())
    }
    .font(.stim(.callout))
    .foregroundStyle(Palette.text)
    .padding(Space.xl)
    .frame(width: 340)
    .background(Palette.surface)
  }
}

private struct ResourceHoverStyle: ButtonStyle {
  let highlighted: Bool
  let namespace: Namespace.ID
  @Environment(\.colorScheme) private var scheme

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .contentShape(Rectangle())
      .background {
        if highlighted {
          Capsule()
            .fill(HoverTint.color(hovering: true, pressed: configuration.isPressed, dark: scheme == .dark))
            .matchedGeometryEffect(id: "resourceHover", in: namespace)
            .allowsHitTesting(false)
        } else if configuration.isPressed {
          Capsule().fill(HoverTint.color(hovering: false, pressed: true, dark: scheme == .dark))
        }
      }
  }
}
