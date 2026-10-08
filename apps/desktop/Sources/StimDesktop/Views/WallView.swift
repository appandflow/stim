import StimKit
import StimStores
import SwiftUI

struct WallView: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var project: Project?
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  var openDevice: (String, String) -> Void
  @AppStorage(AppPreferences.Key.tileSize) private var tileSize = TileSize.medium

  var body: some View {
    let groups = WorktreePage.groups(environments: store.environments(in: project).filter(\.isActive))
    if store.payload == nil {
      if let error = store.error {
        EmptyState(title: "Cannot read stim status", message: error, showsHero: true)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else if groups.isEmpty {
      EmptyState(
        title: project.map { "Nothing running in \(store.title(of: $0))" } ?? "Nothing running",
        message: "Workspaces appear here when an agent warms a worktree or runs stim ios or stim android.",
        showsHero: true, showsPrompts: true
      )
      .id(project?.id)
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: Space.xl) {
          if let project {
            Text(store.title(of: project)).font(.stim(.title))
          }
          FlowLayout(spacing: Space.xxl, lineSpacing: Space.xxl, topAligned: true) {
            ForEach(groups, id: \.id) { page in
              WorktreeSection(
                page: page, store: store, metrics: metrics, tileHeight: tileSize.screenHeight,
                openHeader: { selection = project == nil ? .project(store.project(of: page.apps[0])) : .environment(page.id) },
                openLogs: openLogs, openDevice: openDevice)
            }
          }
        }
        .padding(Space.xxxl)
      }
    }
  }
}

private struct WorktreeSection: View {
  var page: WorktreePage
  var store: StatusStore
  var metrics: MetricsStore
  var tileHeight: Double
  var openHeader: () -> Void
  var openLogs: (String) -> Void
  var openDevice: (String, String) -> Void

  private struct Tile: Identifiable {
    var env: Workspace
    var device: DeviceRef
    var id: String { "\(env.path)|\(device.id)" }
  }

  var body: some View {
    let tiles = page.apps.flatMap { env in
      env.orderedDevices.filter { $0.isRunning || env.runningBuild(for: $0) != nil }.map { Tile(env: env, device: $0) }
    }
    let project = store.project(of: page.apps[0])
    HeaderAboveContent(spacing: Space.md, minimumWidth: 260) {
      VStack(alignment: .leading, spacing: Space.md) {
        WorktreeHeader(page: page, project: project, openHeader: openHeader, openLogs: openLogs)
        ForEach(page.apps) { env in
          if let build = env.build, build.isRunning {
            BuildProgressBar(build: build)
          } else if !env.live, env.isSettingUp {
            SetupBadge(env: env)
          }
          if let macos = env.macos {
            MacosAppCard(app: macos, workspace: env.path)
          }
        }
      }
      if tiles.isEmpty {
        if page.apps.allSatisfy({ $0.macos == nil }) {
          Label("No running devices", systemImage: "iphone.gen3")
            .font(.stim(.callout))
            .foregroundStyle(Palette.secondary)
            .labelStyle(.titleAndIcon)
        }
      } else {
        HStack(alignment: .top, spacing: Space.lg) {
          ForEach(tiles) { tile in
            Button {
              openDevice(tile.env.path, tile.device.id)
            } label: {
              DeviceTile(
                device: tile.device, screenHeight: tileHeight, workspace: tile.env.path,
                build: tile.env.runningBuild(for: tile.device), pausesWhenOffscreen: true, highlightsHeaderOnHover: true
              )
            }
            .buttonStyle(CardPressStyle(highlightsDevice: true))
          }
        }
      }
    }
  }
}

/// Stacks a header over its content, giving the header the content's width so a worktree's chips wrap above its tiles.
private struct HeaderAboveContent: Layout {
  var spacing: CGFloat
  var minimumWidth: CGFloat

  private func widths(_ subviews: Subviews) -> CGFloat {
    max(minimumWidth, subviews.dropFirst().map { $0.sizeThatFits(.unspecified).width }.max() ?? 0)
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let header = subviews.first else { return .zero }
    let width = widths(subviews)
    let headerHeight = header.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
    let rest = subviews.dropFirst().map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
    return CGSize(width: width, height: headerHeight + (rest > 0 ? spacing + rest : 0))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard let header = subviews.first else { return }
    let width = widths(subviews)
    let headerHeight = header.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
    header.place(at: bounds.origin, proposal: ProposedViewSize(width: width, height: headerHeight))
    for view in subviews.dropFirst() {
      view.place(
        at: CGPoint(x: bounds.minX, y: bounds.minY + headerHeight + spacing),
        proposal: ProposedViewSize(width: width, height: nil))
    }
  }
}

struct WorktreeHeader: View {
  var page: WorktreePage
  var project: Project
  var openHeader: () -> Void
  var openLogs: (String) -> Void

  var body: some View {
    let first = page.apps[0]
    let ports = Array(Set(page.apps.compactMap { $0.metro })).sorted { $0.port < $1.port }
    let activities = page.apps.flatMap { $0.devices.filter(\.isRunning).map(\.activity) }
    let drives = page.apps.contains { $0.devices.contains { $0.isRunning && $0.activity?.state == "driven" } }
    let memoryMb = page.apps.reduce(0) { $0 + ($1.memoryMb ?? 0) }
    let errorApps = page.apps.filter { ($0.logs?.errorsSinceMarker ?? 0) > 0 }
    let errors = errorApps.reduce(0) { $0 + ($1.logs?.errorsSinceMarker ?? 0) }
    let tracksErrors = page.apps.contains { $0.logs?.errorsSinceMarker != nil }
    VStack(alignment: .leading, spacing: Space.sm) {
      title(first)
      chips(ports, drives, activities, memoryMb, errors, errorApps, tracksErrors)
    }
  }

  private func title(_ first: Workspace) -> some View {
    Button(action: openHeader) {
      HStack(spacing: Space.lg) {
        Text(first.names.title).font(.stim(.headline)).lineLimit(1).truncationMode(.middle)
        if project.name != first.names.title {
          Text(project.name).font(.stim(.callout)).foregroundStyle(Palette.primary).lineLimit(1).fixedSize()
        }
        if let inCheckout = first.names.inCheckout {
          Text(inCheckout).font(.stim(.callout)).foregroundStyle(Palette.tertiary).lineLimit(1).fixedSize()
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(first.names.title)
  }

  private func chips(
    _ ports: [Metro], _ drives: Bool, _ activities: [DeviceActivity?], _ memoryMb: Int, _ errors: Int,
    _ errorApps: [Workspace], _ tracksErrors: Bool
  ) -> some View {
    FlowLayout(spacing: Space.md, lineSpacing: Space.sm) {
      ForEach(ports, id: \.port) { metro in
        Pill(tone: metro.running ? .neutral : .error) {
          StatusDot(color: metro.running ? Palette.success : Palette.error)
          Text("Metro")
          Text(":\(String(metro.port))").font(.stim(.caption, mono: true))
        }
        .help("Metro on port \(String(metro.port)), \(metro.running ? "running" : "stopped")")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Metro on port \(String(metro.port)), \(metro.running ? "running" : "stopped")")
      }
      if drives { DriversPill(activities: activities) }
      if memoryMb > 0 { MemoryPill(mb: memoryMb, source: page.apps[0].memorySource) }
      if tracksErrors, errors > 0 {
        Button {
          openLogs(errorApps[0].path)
        } label: {
          Pill(tone: .error) { Text(countLabel(errors, "error")) }
        }
        .buttonStyle(.hoverRow())
        .help("\(countLabel(errors, "error")) in the logs since the last marker \u{2014} click to open the logs")
      }
    }
  }
}

struct CardPressAppearance: ViewModifier {
  var pressed: Bool
  var tint: Color = Palette.accent
  @State private var hovering = false

  func body(content: Content) -> some View {
    content
      .overlay {
        RoundedRectangle(cornerRadius: Radius.card)
          .fill(tint.opacity(pressed ? 0.06 : 0))
          .overlay {
            RoundedRectangle(cornerRadius: Radius.card)
              .stroke(Palette.shadow.opacity(pressed ? 0.08 : 0), lineWidth: 4)
              .blur(radius: 2)
              .offset(y: 1)
              .clipShape(RoundedRectangle(cornerRadius: Radius.card))
          }
          .overlay {
            RoundedRectangle(cornerRadius: Radius.card)
              .strokeBorder(tint.opacity(pressed ? 0.35 : hovering ? 0.22 : 0), lineWidth: 1)
          }
          .allowsHitTesting(false)
      }
      .animation(pressed ? nil : .easeOut(duration: 0.08), value: pressed)
      .animation(.easeOut(duration: 0.1), value: hovering)
      .onHover { hovering = $0 }
  }
}

struct CardPressedKey: PreferenceKey {
  static let defaultValue = false

  static func reduce(value: inout Bool, nextValue: () -> Bool) {
    value = nextValue() || value
  }
}

struct CardPressStyle: ButtonStyle {
  var highlightsDevice = false

  @ViewBuilder
  func makeBody(configuration: Configuration) -> some View {
    if highlightsDevice {
      CardPressBody(configuration: configuration, reportsPress: false)
        .modifier(CardPressAppearance(pressed: configuration.isPressed, tint: Palette.secondary))
    } else {
      CardPressBody(configuration: configuration)
    }
  }
}

struct CardPressBody: View {
  var configuration: ButtonStyleConfiguration
  var reportsPress = true
  @State private var cursorPushed = false
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    configuration.label
      .contentShape(Rectangle())
      .preference(key: CardPressedKey.self, value: reportsPress && configuration.isPressed)
      .onHover { inside in
        updateCursor(inside && isEnabled)
      }
      .onChange(of: isEnabled) { _, enabled in
        if !enabled { updateCursor(false) }
      }
      .onDisappear { updateCursor(false) }
  }

  private func updateCursor(_ pushed: Bool) {
    guard cursorPushed != pushed else { return }
    cursorPushed = pushed
    if pushed { NSCursor.pointingHand.push() } else { NSCursor.pop() }
  }
}

struct WorkspaceHeader: View {
  var env: Workspace
  var project: Project
  var usage: UsageHistory?
  var compact = false
  var stacked = false
  var openLogs: () -> Void

  var body: some View {
    VStack(alignment: stacked ? .center : .leading, spacing: Space.md) {
      row
      if let build = env.build, build.isRunning {
        BuildProgressBar(build: build).frame(maxWidth: 520)
      } else if !env.live, env.isSettingUp {
        SetupBadge(env: env).frame(maxWidth: 520, alignment: .leading)
      }
    }
    .contentShape(Rectangle())
  }

  @ViewBuilder private var row: some View {
    if stacked {
      chips
    } else {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: Space.lg) {
          titleGroup
          Spacer(minLength: 12)
          chips
        }
        VStack(alignment: .leading, spacing: Space.md) {
          titleGroup
          chips
        }
      }
    }
  }

  private var titleGroup: some View {
    HStack(spacing: Space.lg) {
      Text(env.names.title).font(.stim(.headline)).lineLimit(1).truncationMode(.middle)
      if project.name != env.names.title {
        Text(project.name).font(.stim(.callout)).foregroundStyle(Palette.primary).lineLimit(1).fixedSize()
      }
      if let inCheckout = env.names.inCheckout {
        Text(inCheckout).font(.stim(.callout)).foregroundStyle(Palette.tertiary).lineLimit(1).fixedSize()
      }
    }
  }

  private var chips: some View {
    FlowLayout(spacing: Space.md, lineSpacing: Space.sm, centered: stacked) {
      if let metro = env.metro {
        Pill(tone: metro.running ? .neutral : .error) {
          StatusDot(color: metro.running ? Palette.success : Palette.error)
          Text("Metro")
          Text(":\(String(metro.port))").font(.stim(.caption, mono: true))
        }
        .help("Metro on port \(String(metro.port)), \(metro.running ? "running" : "stopped")")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Metro on port \(String(metro.port)), \(metro.running ? "running" : "stopped")")
      }
      if env.devices.contains(where: { $0.isRunning && $0.activity?.state == "driven" }) {
        DriversPill(activities: env.devices.filter(\.isRunning).map(\.activity))
      }
      if let supervisor = env.supervisor, supervisor.healthy != true {
        Pill(tone: .warning) { Text("supervisor unhealthy") }
          .help("stim status reports this workspace's dev server supervisor as unhealthy")
      }
      if !compact, let cpu = usage?.latest.cpuPercent, let usage {
        Pill {
          Sparkline(values: usage.cpu, minimumPeak: 100).frame(width: 34, height: 12)
          Text("CPU")
          Text(formatPercent(cpu)).font(.stim(.caption, mono: true))
        }
        .help("CPU of the workspace's processes, simulators and emulators, as a percent of one core")
      }
      if !compact, let usage, usage.isFootprint {
        Pill {
          Sparkline(values: usage.memory, minimumPeak: 1_073_741_824).frame(width: 34, height: 12)
          Text("RAM")
          Text(Format.memory(usage.memoryBytes)).font(.stim(.caption, mono: true))
        }
        .help("Memory the workspace's processes, simulators and emulators use, as Activity Monitor counts it")
      } else if !compact, let mb = env.memoryMb, mb > 0 {
        MemoryPill(mb: mb, source: env.memorySource)
      }
      if let errors = env.logs?.errorsSinceMarker, !compact || errors > 0 {
        Button(action: openLogs) {
          Pill(tone: errors > 0 ? .error : .neutral) { Text(countLabel(errors, "error")) }
        }
        .buttonStyle(.hoverRow())
        .help("\(countLabel(errors, "error")) in the logs since the last marker \u{2014} click to open the logs")
      }
    }
  }
}
