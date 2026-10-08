import StimKit
import StimStores
import SwiftUI

struct WallView: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var project: Project?
  var scope = ProjectScope.active
  var setScope: (ProjectScope) -> Void = { _ in }
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  var openDevice: (String, String) -> Void
  @AppStorage(AppPreferences.Key.tileSize) private var tileSize = TileSize.medium
  @State private var pressedCard: String?

  var body: some View {
    let content = ProjectPage.content(environments: store.environments(in: project), scope: project == nil ? .active : scope)
    let shown: [Workspace] = if case .worktrees(let environments) = content { environments } else { [] }
    let cards = WallCard.cards(environments: shown)
    if store.payload == nil {
      if let error = store.error {
        EmptyState(title: "Cannot Read stim status", message: error, showsHero: true)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else if let project, content == .noneActive {
      VStack(spacing: Space.lg) {
        Text("No active workspaces in \(store.title(of: project))").font(.stim(.headline))
        Text("The project has workspaces, but none is running or being set up.").foregroundStyle(Palette.secondary)
        Button("Show all") { setScope(.all) }
          .buttonStyle(.hoverRow(outset: Space.xs)).foregroundStyle(Palette.primary)
      }
      .padding(Space.huge)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .id(project.id)
    } else if shown.isEmpty {
      EmptyState(
        title: project.map { "Nothing Running in \(store.title(of: $0))" } ?? "Nothing Running",
        message: "Workspaces appear here when an agent warms a worktree or runs stim ios or stim android.",
        showsHero: true, showsPrompts: true
      )
      .id(project?.id)
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: Space.xl) {
          if let project {
            HStack(spacing: Space.lg) {
              Text(store.title(of: project)).font(.stim(.title))
              if scope == .all {
                Button {
                  setScope(.active)
                } label: {
                  Pill {
                    Text("Showing all workspaces")
                    Image(systemName: "xmark").font(.stim(.caption))
                  }
                }
                .buttonStyle(.hoverRow())
                .help("Show only active workspaces")
                .accessibilityLabel("Showing all workspaces. Show only active workspaces")
              }
            }
          }
          ForEach(cards) { card in
            let open = {
              pressedCard = nil
              selection = project == nil ? .project(store.project(of: card.apps[0].workspace)) : .environment(card.id)
            }
            let noDevices = card.apps.allSatisfy { $0.devices.isEmpty }
            Card(fill: noDevices ? Palette.surface : .clear, border: Palette.border, clipsContent: false) {
              VStack(alignment: .leading, spacing: Space.lg) {
                if card.isMultiApp {
                  Button(action: open) {
                    WorktreeHeader(env: card.apps[0].workspace, project: store.project(of: card.apps[0].workspace))
                  }
                  .buttonStyle(CardPressStyle())
                  .accessibilityLabel(card.apps[0].workspace.names.title)
                  ForEach(card.apps) { app in
                    appGroup(app, openCard: open)
                  }
                } else {
                  let app = card.apps[0]
                  let env = app.workspace
                  Button(action: open) {
                    WorkspaceHeader(
                      env: env, project: store.project(of: env), usage: metrics.usage[env.path], compact: app.devices.isEmpty,
                      openLogs: { openLogs(env.path) }
                    )
                  }
                  .buttonStyle(CardPressStyle())
                  .accessibilityLabel(env.names.title)
                  appBody(app)
                }
              }
              .padding(Space.xl)
              .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
            .hoverHighlight(radius: Radius.card)
            .modifier(CardPressAppearance(pressed: pressedCard == card.id))
            .onPreferenceChange(CardPressedKey.self) { pressed in
              if pressed {
                pressedCard = card.id
              } else if pressedCard == card.id {
                pressedCard = nil
              }
            }
          }
        }
        .padding(Space.xxxl)
      }
    }
  }
  private func appGroup(_ app: WallCard.App, openCard: @escaping () -> Void) -> some View {
    let env = app.workspace
    return VStack(alignment: .leading, spacing: Space.lg) {
      Divider()
      ViewThatFits(in: .horizontal) {
        HStack(spacing: Space.lg) {
          appLabel(app)
          Spacer(minLength: 12)
          appChips(app)
        }
        VStack(alignment: .leading, spacing: Space.md) {
          appLabel(app)
          appChips(app)
        }
      }
      if let build = env.build, build.isRunning {
        BuildProgressBar(build: build).frame(maxWidth: 520)
      } else if !env.live, env.isSettingUp {
        SetupBadge(env: env).frame(maxWidth: 520, alignment: .leading)
      }
      appBody(app)
    }
  }

  private func appLabel(_ app: WallCard.App) -> some View {
    Button {
      pressedCard = nil
      selection = .environment(app.workspace.path)
    } label: {
      Text(app.label).font(.stim(.callout, weight: .medium)).lineLimit(1).truncationMode(.middle)
    }
    .buttonStyle(.hoverRow())
    .help("Open \(app.label)")
    .accessibilityLabel(app.label)
  }

  private func appChips(_ app: WallCard.App) -> some View {
    WorkspaceChips(
      env: app.workspace, usage: metrics.usage[app.workspace.path], compact: app.devices.isEmpty, stacked: false,
      openLogs: { openLogs(app.workspace.path) })
  }

  @ViewBuilder
  private func appBody(_ app: WallCard.App) -> some View {
    let env = app.workspace
    if let macos = env.macos {
      MacosAppCard(app: macos, workspace: env.path)
    }
    if app.devices.isEmpty && env.macos == nil {
      Label("No Running Devices", systemImage: "iphone.gen3")
        .font(.stim(.callout))
        .foregroundStyle(Palette.secondary)
        .labelStyle(.titleAndIcon)
    } else if !app.devices.isEmpty {
      FlowLayout(spacing: Space.xl, lineSpacing: Space.xl, topAligned: true) {
        ForEach(app.devices) { device in
          Button {
            openDevice(env.path, device.id)
          } label: {
            DeviceTile(
              device: device, screenHeight: tileSize.screenHeight, workspace: env.path,
              build: env.runningBuild(for: device), pausesWhenOffscreen: true,
              highlightsHeaderOnHover: true
            )
          }
          .buttonStyle(CardPressStyle(highlightsDevice: true))
        }
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
    WorkspaceChips(env: env, usage: usage, compact: compact, stacked: stacked, openLogs: openLogs)
  }
}

struct WorktreeHeader: View {
  var env: Workspace
  var project: Project

  var body: some View {
    HStack(spacing: Space.lg) {
      Text(env.names.title).font(.stim(.headline)).lineLimit(1).truncationMode(.middle)
      if project.name != env.names.title {
        Text(project.name).font(.stim(.callout)).foregroundStyle(Palette.primary).lineLimit(1).fixedSize()
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
  }
}

struct WorkspaceChips: View {
  var env: Workspace
  var usage: UsageHistory?
  var compact = false
  var stacked = false
  var openLogs: () -> Void

  var body: some View {
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
