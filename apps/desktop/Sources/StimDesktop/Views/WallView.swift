import StimKit
import StimStores
import SwiftUI

struct WallView: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var project: Project?
  var overview = false
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  var openDevice: (String, String) -> Void
  @AppStorage(AppPreferences.Key.tileSize) private var tileSize = TileSize.medium
  @State private var pressedCard: SidebarItem?
  @State private var hoveredCard: String?
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let live = store.environments(in: project).filter {
      !overview && project == nil ? $0.live : $0.isActive
    }
    if store.payload == nil {
      if let error = store.error {
        EmptyState(title: "Cannot read stim status", message: error, showsHero: true)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else if live.isEmpty {
      EmptyState(
        title: project.map { "Nothing running in \(store.title(of: $0))" } ?? "Nothing running",
        message: "Workspaces appear here when an agent warms a worktree or runs stim ios or stim android.",
        showsHero: true, showsPrompts: true
      )
      .id(project?.id)
    } else if overview {
      projectGrid
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: Space.xl) {
          if let project {
            Text(store.title(of: project)).font(.stim(.title))
          }
          ForEach(live) { env in
            let devices = env.devices.filter { $0.isRunning || env.runningBuild(for: $0) != nil }
            Card(
              fill: hoveredCard == env.path ? .white : (devices.isEmpty ? Palette.surface : .clear),
              border: Palette.border, clipsContent: false
            ) {
              VStack(alignment: .leading, spacing: Space.lg) {
                Button {
                  openCard(.project(store.project(of: env)))
                } label: {
                  WorkspaceHeader(
                    env: env, project: store.project(of: env), usage: metrics.usage[env.path], compact: devices.isEmpty,
                    openLogs: { openLogs(env.path) }
                  )
                }
                .buttonStyle(CardPressStyle())
                .accessibilityLabel(env.names.title)
                if let macos = env.macos {
                  MacosAppCard(app: macos, workspace: env.path)
                }
                if devices.isEmpty && env.macos == nil {
                  Label("No running devices", systemImage: "iphone.gen3")
                    .font(.stim(.callout))
                    .foregroundStyle(Palette.secondary)
                    .labelStyle(.titleAndIcon)
                } else if !devices.isEmpty {
                  ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: Space.xl) {
                      ForEach(devices) { device in
                        Button {
                          openDevice(env.path, device.id)
                        } label: {
                          DeviceTile(
                            device: device, screenHeight: tileSize.screenHeight, workspace: env.path,
                            build: env.runningBuild(for: device), pausesWhenOffscreen: true, highlightsHeaderOnHover: true
                          )
                          .environment(\.colorScheme, colorScheme)
                        }
                        .buttonStyle(CardPressStyle(highlightsDevice: true))
                      }
                    }
                  }
                }
              }
              .padding(Space.xl)
              .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(Rectangle())
            .onHover { inside in
              hoveredCard = inside ? env.path : nil
            }
            .environment(\.colorScheme, hoveredCard == env.path ? .light : colorScheme)
            .onTapGesture {
              openCard(.project(store.project(of: env)))
            }
            .hoverHighlight(radius: Radius.card)
            .modifier(CardPressAppearance(pressed: pressedCard == .environment(env.path)))
            .onPreferenceChange(CardPressedKey.self) { pressed in
              updatePress(pressed, card: .environment(env.path))
            }
          }
        }
        .padding(Space.xxxl)
      }
    }
  }

  private func openCard(_ destination: SidebarItem) {
    pressedCard = nil
    selection = destination
  }

  private func updatePress(_ pressed: Bool, card: SidebarItem) {
    if pressed {
      pressedCard = card
    } else if pressedCard == card {
      pressedCard = nil
    }
  }

  private var projectGrid: some View {
    GeometryReader { geometry in
      let availableWidth = max(0, geometry.size.width - Space.xxxl * 2)
      let columnCount = min(3, max(1, Int((availableWidth + Space.xl) / (320 + Space.xl))))
      let columns = Array(
        repeating: GridItem(.flexible(), spacing: Space.xl, alignment: .top), count: columnCount)
      ScrollView {
        LazyVGrid(columns: columns, alignment: .leading, spacing: Space.xl) {
          ForEach(store.projectList, id: \.project.id) { summary in
            let worktrees = WorktreePage.groups(
              environments: store.environments(in: summary.project).filter(\.isActive)
            ).sorted { $0.identity < $1.identity }
            if !worktrees.isEmpty {
              let itemCount = worktrees.reduce(0) { total, worktree in
                total + max(1, worktree.orderedDevices.filter { $0.device.isRunning }.count)
              }
              let moreCount = itemCount - 1
              Button {
                openCard(.project(summary.project))
              } label: {
                Card {
                  VStack(alignment: .center, spacing: Space.xl) {
                    Text(store.title(of: summary.project))
                      .font(.stim(.headline))
                      .foregroundStyle(Palette.text)
                      .lineLimit(2)
                    projectPreview(worktrees)
                      .allowsHitTesting(false)
                    if moreCount > 0 {
                      Text("Show more (\(moreCount))")
                        .foregroundStyle(Palette.tertiary)
                    }
                  }
                  .padding(Space.xl)
                  .frame(maxWidth: .infinity, alignment: .center)
                  .multilineTextAlignment(.center)
                  .contentShape(Rectangle())
                }
              }
              .buttonStyle(CardPressStyle())
              .hoverHighlight(radius: Radius.card)
              .modifier(CardPressAppearance(pressed: pressedCard == .project(summary.project)))
              .onPreferenceChange(CardPressedKey.self) { pressed in
                updatePress(pressed, card: .project(summary.project))
              }
              .accessibilityElement(children: .ignore)
              .accessibilityLabel(store.title(of: summary.project))
              .accessibilityValue(moreCount > 0 ? "Show more (\(moreCount))" : "")
              .accessibilityHint("Open project")
            }
          }
        }
        .padding(Space.xxxl)
      }
    }
  }

  private func projectPreview(_ worktrees: [WorktreePage]) -> some View {
    let preview = worktrees.flatMap(\.orderedDevices).first {
      $0.device.isRunning
    }
    return VStack(alignment: .center, spacing: Space.lg) {
      if let env = preview?.workspace ?? worktrees.first?.apps.first {
        WorkspaceHeader(
          env: env, project: store.project(of: env), usage: metrics.usage[env.path], stacked: true,
          openLogs: { openLogs(env.path) }
        )
        if let preview {
          let device = preview.device
          DeviceTile(
            device: device, screenHeight: 220, workspace: env.path,
            build: env.runningBuild(for: device), maxWidth: 240, pausesWhenOffscreen: true
          )
          .frame(maxWidth: .infinity, alignment: .center)
        }
        if let macos = env.macos {
          Label("\(macos.product) \u{00B7} \(macos.state)", systemImage: "macwindow")
            .font(.stim(.callout))
            .foregroundStyle(Palette.secondary)
        }
      }
    }
  }
}

private struct CardPressAppearance: ViewModifier {
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
              .stroke(.black.opacity(pressed ? 0.08 : 0), lineWidth: 4)
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

private struct CardPressedKey: PreferenceKey {
  static let defaultValue = false

  static func reduce(value: inout Bool, nextValue: () -> Bool) {
    value = nextValue() || value
  }
}

private struct CardPressStyle: ButtonStyle {
  var highlightsDevice = false

  @ViewBuilder
  func makeBody(configuration: Configuration) -> some View {
    if highlightsDevice {
      CardPressBody(configuration: configuration, reportsPress: false)
        .modifier(CardPressAppearance(pressed: configuration.isPressed, tint: Color(white: 0.22)))
    } else {
      CardPressBody(configuration: configuration)
    }
  }
}

private struct CardPressBody: View {
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
