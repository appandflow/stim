import AppKit
import EmulatorFrames
import SimulatorFrames
import StimKit
import StimStores
import SwiftUI

struct DeviceViewer: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var deviceID: String
  var machine: MachineUsage?
  /// The main window's size, which caps the sheet's.
  var windowSize: CGSize
  /// Shows the workspace's agent logs for `slot`, scrolled to `at` when given.
  var revealInLogs: (_ slot: String, _ at: Double?) -> Void
  var close: () -> Void
  @State private var takenOver = false
  @State private var escapeMonitor: Any?
  @State private var window = WindowRef()
  @State private var scalingMode = DeviceScalingMode.fit
  @State private var displayMetrics: DeviceDisplayMetrics?
  @State private var backingScale: CGFloat = 1
  @State private var displayPointsPerInch: CGFloat?
  @FocusState private var actionsFocused: Bool
  @AppStorage(AppPreferences.Key.viewerShowsActions) private var showsActions = true
  @EnvironmentObject private var actions: ActionCenter
  @ObservedObject private var server = ServerSession.shared

  static let minimumSize = CGSize(width: 560, height: 480)
  static let actionsWidth: CGFloat = 360
  private static let minimumCanvasWidth: CGFloat = 420
  /// Room left around the sheet, so the window under it still shows.
  private static let windowMargin = CGSize(width: 64, height: 40)

  static func size(in window: CGSize) -> CGSize {
    CGSize(
      width: max(minimumSize.width, window.width - windowMargin.width),
      height: max(minimumSize.height, window.height - windowMargin.height))
  }

  var body: some View {
    let size = Self.size(in: windowSize)
    Group {
      if let device {
        AgentFeed(cli: cli, workspace: env.path, device: device) { agentActions in
          if let target = replayTarget(device) {
            ReplayHost(target: target) { replay in
              ReplayingContent(replay: replay) { replaying in
                content(device, size: size, agentActions: agentActions, replay: replay, replaying: replaying)
              }
            }
          } else {
            content(device, size: size, agentActions: agentActions, replay: nil, replaying: false)
          }
        }
      } else {
        VStack(spacing: 0) {
          HStack {
            Spacer()
            Button("Close", systemImage: "xmark", action: close)
              .labelStyle(.iconOnly)
              .nativeIconStyle()
              .help("Close (Escape)")
          }
          .padding(.horizontal, Space.xl)
          .padding(.vertical, Space.md)
          EmptyState(title: "Device gone", message: "stim status no longer reports this device.")
            .frame(maxHeight: .infinity)
        }
      }
    }
    .frame(width: size.width, height: size.height)
    .background(Palette.background)
    .background(WindowReader(found: window, changed: updateDisplayScale))
    .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeScreenNotification)) { event in
      if event.object as? NSWindow === window.window { updateDisplayScale() }
    }
    .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeBackingPropertiesNotification)) { event in
      if event.object as? NSWindow === window.window { updateDisplayScale() }
    }
    .task(id: deviceID) {
      switch device {
      case .ios(_, let sim) where !sim.physical: displayMetrics = SimulatorDisplayMetrics.load(udid: sim.udid)
      case .android(_, let avd) where !avd.physical: displayMetrics = EmulatorDisplayMetrics.load(avdName: avd.name)
      default: displayMetrics = nil
      }
      scalingMode = .fit
    }
    .onAppear {
      watchEscape()
      takenOver =
        device.map {
          $0.isInteractive && (!$0.isPhysical || PhysicalScreen(device: $0, link: server.link, now: Date()).canControl)
        } ?? false
      actionsFocused = !takenOver
    }
    .onDisappear(perform: unwatchEscape)
    .sheet(item: $actions.presented) { run in
      ActivitySheet(run: run).environmentObject(actions)
    }
    .onChange(of: device?.isInteractive) { _, interactive in
      if interactive != true { takenOver = false }
    }
    .onChange(of: takenOver) { _, takenOver in
      actionsFocused = !takenOver
    }
  }

  private var device: DeviceRef? { env.orderedDevices.first { $0.id == deviceID } }

  private func content(
    _ device: DeviceRef, size: CGSize, agentActions: [AgentAction], replay: ReplayController?, replaying: Bool
  ) -> some View {
    let hasActions = Self.hasActions(device)
    let fits = size.width - Self.actionsWidth - 1 >= Self.minimumCanvasWidth
    let listed = hasActions && fits && showsActions
    return VStack(spacing: 0) {
      DeviceViewerToolbar(
        device: device, env: env, usage: device.isRunning ? env.usage(of: device, machine: machine) : nil,
        takenOver: $takenOver, replaying: replaying, showsActions: hasActions && fits ? $showsActions : nil,
        scalingMode: $scalingMode, scalingModes: scalingModes(device, replaying: replaying),
        close: close)
      Rectangle().fill(Palette.border).frame(height: 1)
      HStack(spacing: 0) {
        VStack(spacing: 0) {
          canvas(device, replay: replay, replaying: replaying)
          if let replay, replaying || env.replayOff || replay.timeline != nil {
            Rectangle().fill(Palette.border).frame(height: 1)
            ReplayBar(
              controller: replay, running: device.isRunning, replayOff: env.replayOff,
              onSeek: { takenOver = false }
            )
            .padding(.horizontal, Space.xl)
            .padding(.vertical, Space.md)
            .background(Palette.surface)
          }
        }
        if listed {
          Rectangle().fill(Palette.border).frame(width: 1)
          AgentActionsPanel(
            actions: agentActions, replay: replay,
            canReplay: replay != nil && !env.replayOff && replay?.replayable != false,
            focused: $actionsFocused,
            seek: { action in
              if let replay { seek(action, replay: replay) }
            },
            playOrPause: replay.map { replay in
              {
                guard !env.replayOff, replay.replayable != false, let timeline = replay.timeline else { return }
                ReplayBar.playOrPause(
                  replay, timeline: timeline, running: device.isRunning, onSeek: { takenOver = false })
              }
            },
            openLogs: { action in
              revealInLogs(device.slot, action?.record.ts)
              close()
            }
          )
          .frame(width: Self.actionsWidth)
          .background(Palette.sidebar)
        }
      }
    }
  }

  private func canvas(_ device: DeviceRef, replay: ReplayController?, replaying: Bool) -> some View {
    GeometryReader { geo in
      let padding = Space.xxl
      let interactive = device.isRunning && takenOver && !replaying
      ScrollView([.horizontal, .vertical]) {
        DeviceTile(
          device: device, screenHeight: max(160, geo.size.height - padding * 2),
          interactive: interactive, workspace: env.path,
          build: env.runningBuild(for: device),
          replay: replay, replaying: replaying,
          presence: env.appPresence(device),
          showsCovers: true,
          viewer: true,
          maxWidth: max(DeviceTile.minimumWidth, geo.size.width - padding * 2),
          pixelScale: devicePixelScale(
            mode: replaying ? .fit : scalingMode, device: displayMetrics,
            backingScale: backingScale, displayPointsPerInch: displayPointsPerInch),
          framePixelsPerUnit: device.platform == "ios" ? displayMetrics?.pixelsPerPoint ?? 1 : 1,
          onControlLost: { takenOver = false }
        )
        .frame(minWidth: geo.size.width, minHeight: geo.size.height)
      }
      .onChange(of: replaying) { _, replaying in
        if replaying { takenOver = false }
      }
    }
    .background(Palette.grouped)
  }

  private func scalingModes(_ device: DeviceRef, replaying: Bool) -> [DeviceScalingMode] {
    guard !replaying, device.isRunning, !device.isPhysical, device.formFactor != .dual,
      device.platform == "ios" || device.platform == "android"
    else { return [.fit] }
    return DeviceScalingMode.allCases.filter {
      $0 == .fit
        || devicePixelScale(
          mode: $0, device: displayMetrics, backingScale: backingScale, displayPointsPerInch: displayPointsPerInch) != nil
    }
  }

  private func updateDisplayScale() {
    guard let viewerWindow = window.window else { return }
    backingScale = viewerWindow.backingScaleFactor
    guard let screen = viewerWindow.screen,
      let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
    else {
      displayPointsPerInch = nil
      if scalingMode == .physicalSize { scalingMode = .fit }
      return
    }
    let millimeters = CGDisplayScreenSize(number.uint32Value).width
    displayPointsPerInch = StimKit.displayPointsPerInch(pointWidth: screen.frame.width, physicalWidthMillimeters: millimeters)
    if scalingMode == .physicalSize, displayPointsPerInch == nil { scalingMode = .fit }
  }

  /// Plays from just before the action, counting it as the action shown while the seek lands before it.
  private func seek(_ action: AgentAction, replay: ReplayController) {
    guard let at = replay.timeline?.seekTime(forActionAt: action.at) else { return }
    takenOver = false
    replay.stepped = action.at
    replay.seek(at: at, rate: replay.speed)
  }

  /// Physical and remote devices report no agent actions.
  private static func hasActions(_ device: DeviceRef) -> Bool {
    !device.isPhysical && device.activityKey != nil
  }

  /// Physical and remote devices have no replay, as on the phone.
  private func replayTarget(_ device: DeviceRef) -> ReplayTarget? {
    switch device {
    case .remote: return nil
    case _ where device.isPhysical: return nil
    default: return ReplayTarget(workspace: env.path, platform: device.platform, slot: device.slot)
    }
  }

  /// The device's own view takes Escape while it has the keyboard, so the key is caught before any view sees it,
  /// only in the viewer's own window and only while nothing is presented over it.
  private func watchEscape() {
    let released = $takenOver
    let viewerWindow = window
    escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [close] event in
      guard event.keyCode == 0x35, !event.isARepeat,
        event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty,
        let window = viewerWindow.window, event.window === window, window.attachedSheet == nil
      else { return event }
      if released.wrappedValue {
        released.wrappedValue = false
      } else {
        close()
      }
      return nil
    }
  }

  private func unwatchEscape() {
    if let escapeMonitor { NSEvent.removeMonitor(escapeMonitor) }
    escapeMonitor = nil
  }
}

/// Re-renders its content as the replay starts or stops, or its footage appears or goes, and not as the replay
/// moves, so playing and scrubbing redraw only the replay bar, the screen and the action highlighted.
private struct ReplayingContent<Content: View>: View {
  private struct Shown: Equatable {
    var replaying: Bool
    var hasFootage: Bool
    var replayable: Bool?
  }

  var replay: ReplayController
  @ViewBuilder var content: (Bool) -> Content
  @State private var shown = Shown(replaying: false, hasFootage: false)

  var body: some View {
    content(shown.replaying)
      .onReceive(
        replay.$replay.combineLatest(replay.$range, replay.$replayable)
          .map { Shown(replaying: $0 != nil, hasFootage: !($1?.spans.isEmpty ?? true), replayable: $2) }
          .removeDuplicates()
      ) { shown = $0 }
  }
}

/// The window a view is in, held weakly: the window owns the view's state, so a strong reference keeps a dismissed
/// sheet and everything in it alive.
private final class WindowRef {
  weak var window: NSWindow?
}

/// Hands out the window a view is in.
private struct WindowReader: NSViewRepresentable {
  var found: WindowRef
  var changed: () -> Void

  func makeNSView(context: Context) -> NSView { WindowView(found: found, changed: changed) }

  func updateNSView(_ view: NSView, context: Context) {}

  private final class WindowView: NSView {
    let found: WindowRef
    let changed: () -> Void

    init(found: WindowRef, changed: @escaping () -> Void) {
      self.found = found
      self.changed = changed
      super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      found.window = window
      DispatchQueue.main.async { [changed] in changed() }
    }
  }
}
