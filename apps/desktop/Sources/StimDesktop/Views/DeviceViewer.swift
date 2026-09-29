import AppKit
import StimKit
import SwiftUI

/// One device of a workspace, large: its live screen, Take over and Release with the device's buttons, replay, the
/// agent row and Stop. Escape releases a device that is taken over, and otherwise closes the viewer. A command it
/// starts shows its activity sheet over the viewer, since the window under the viewer cannot present another sheet.
struct DeviceViewer: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var deviceID: String
  var machine: MachineUsage?
  var close: () -> Void
  @State private var takenOver = false
  @State private var escapeMonitor: Any?
  @State private var window = WindowRef()
  @EnvironmentObject private var actions: ActionCenter

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: Space.md) {
        Text(env.names.title).font(.stim(.callout, weight: .semibold)).lineLimit(1)
        if let device {
          Text(device.label).font(.stim(.callout)).foregroundStyle(Palette.secondary).lineLimit(1)
        }
        Spacer(minLength: Space.md)
        Button("Close", systemImage: "xmark", action: close)
          .labelStyle(.iconOnly)
          .buttonStyle(.stim(.plain))
          .help(takenOver ? "Close the viewer and release the device (Escape releases first)" : "Close (Escape)")
      }
      .padding(.horizontal, Space.xl)
      .padding(.vertical, Space.md)
      Rectangle().fill(Palette.border).frame(height: 1)
      GeometryReader { geo in
        Group {
          if let device {
            viewer(device, size: geo.size)
          } else {
            EmptyState(title: "Device gone", message: "stim status no longer reports this device.")
          }
        }
        .frame(width: geo.size.width, height: geo.size.height)
      }
      .padding(Space.xl)
    }
    .background(Palette.background)
    .frame(minWidth: 480, idealWidth: 760, maxWidth: .infinity, minHeight: 600, idealHeight: 920, maxHeight: .infinity)
    .background(WindowReader(found: window))
    .onAppear(perform: watchEscape)
    .onDisappear(perform: unwatchEscape)
    .sheet(item: $actions.presented) { run in
      ActivitySheet(run: run).environmentObject(actions)
    }
    .onChange(of: device?.isInteractive) { _, interactive in
      if interactive != true { takenOver = false }
    }
  }

  private var device: DeviceRef? { env.orderedDevices.first { $0.id == deviceID } }

  @ViewBuilder private func viewer(_ device: DeviceRef, size: CGSize) -> some View {
    if let target = replayTarget(device) {
      ReplayHost(target: target) { replay in
        ReplayingTile(replay: replay) { replaying in
          let bar = replaying || env.replayOff || replay.timeline != nil
          tile(
            device, screenHeight: screenHeight(device, height: size.height, replayBar: bar), maxWidth: size.width,
            replay: replay, replaying: replaying
          )
          .onChange(of: replaying) { _, replaying in
            if replaying { takenOver = false }
          }
        }
      }
    } else {
      tile(
        device, screenHeight: screenHeight(device, height: size.height, replayBar: false), maxWidth: size.width,
        replay: nil, replaying: false)
    }
  }

  /// What the tile leaves for the screen: its header, the agent row, and the button row and replay bar when shown.
  private func screenHeight(_ device: DeviceRef, height: CGFloat, replayBar: Bool) -> CGFloat {
    let local = device.isRunning && !device.isPhysical
    let agentRow: CGFloat = local && device.activityKey != nil ? 40 : 0
    let buttonRow: CGFloat = takenOver && local && ["ios", "android"].contains(device.platform) ? 50 : 0
    return max(240, height - 110 - agentRow - buttonRow - (replayBar ? 60 : 0))
  }

  /// Physical and remote devices have no replay, as on the phone.
  private func replayTarget(_ device: DeviceRef) -> ReplayTarget? {
    switch device {
    case .remote: return nil
    case _ where device.isPhysical: return nil
    default: return ReplayTarget(workspace: env.path, platform: device.platform, slot: device.slot)
    }
  }

  private func tile(
    _ device: DeviceRef, screenHeight: CGFloat, maxWidth: CGFloat, replay: ReplayController?, replaying: Bool
  ) -> some View {
    DeviceTile(
      device: device, screenHeight: screenHeight,
      interactive: device.isRunning && takenOver && !replaying, workspace: env.path,
      workspaceTitle: env.names.title,
      build: env.runningBuild(for: device),
      takenOver: takenOver && !replaying,
      onToggleTakeOver: device.isInteractive ? { takenOver.toggle() } : nil,
      replay: replay, replaying: replaying, replayOff: env.replayOff,
      onReplaySeek: { takenOver = false },
      usage: device.isRunning ? env.usage(of: device, machine: machine) : nil,
      presence: env.appPresence(device),
      cli: cli,
      showsCovers: true,
      viewer: true,
      maxWidth: maxWidth)
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
/// moves, so playing and scrubbing redraw only the replay bar and screen.
private struct ReplayingTile<Content: View>: View {
  private struct Shown: Equatable {
    var replaying: Bool
    var hasFootage: Bool
  }

  var replay: ReplayController
  @ViewBuilder var content: (Bool) -> Content
  @State private var shown = Shown(replaying: false, hasFootage: false)

  var body: some View {
    content(shown.replaying)
      .onReceive(
        replay.$replay.combineLatest(replay.$range)
          .map { Shown(replaying: $0 != nil, hasFootage: !($1?.spans.isEmpty ?? true)) }
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

  func makeNSView(context: Context) -> NSView { WindowView(found: found) }

  func updateNSView(_ view: NSView, context: Context) {}

  private final class WindowView: NSView {
    let found: WindowRef

    init(found: WindowRef) {
      self.found = found
      super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      found.window = window
    }
  }
}
