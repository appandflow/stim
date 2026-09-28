import AppKit
import StimKit
import SwiftUI

/// One device of a workspace, large: its live screen, Take over and Release with the device's buttons, replay, the
/// agent row and Stop. Escape releases a device that is taken over, and otherwise closes the viewer.
struct DeviceViewer: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var deviceID: String
  var machine: MachineUsage?
  var close: () -> Void
  @State private var takenOver = false
  @State private var escapeMonitor: Any?


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
            viewer(device, height: geo.size.height)
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
    .onAppear(perform: watchEscape)
    .onDisappear(perform: unwatchEscape)
    .onChange(of: device?.isInteractive) { _, interactive in
      if interactive != true { takenOver = false }
    }
  }

  private var device: DeviceRef? { env.orderedDevices.first { $0.id == deviceID } }

  @ViewBuilder private func viewer(_ device: DeviceRef, height: CGFloat) -> some View {
    if let target = replayTarget(device) {
      ReplayHost(target: target) { replay in
        ReplayingTile(replay: replay) { replaying in
          let bar = replaying || env.replayOff || replay.timeline != nil
          tile(
            device, screenHeight: screenHeight(device, height: height, replayBar: bar), replay: replay,
            replaying: replaying)
        }
      }
    } else {
      tile(device, screenHeight: screenHeight(device, height: height, replayBar: false), replay: nil, replaying: false)
    }
  }

  /// What the tile leaves for the screen: its header, the agent row, and the button row and replay bar when shown.
  private func screenHeight(_ device: DeviceRef, height: CGFloat, replayBar: Bool) -> CGFloat {
    let chrome: CGFloat = 110 + (device.activityKey == nil ? 0 : 40) + (takenOver ? 50 : 0) + (replayBar ? 60 : 0)
    return max(240, height - chrome)
  }

  /// Physical and remote devices have no replay, as on the phone.
  private func replayTarget(_ device: DeviceRef) -> ReplayTarget? {
    switch device {
    case .remote: return nil
    case _ where device.isPhysical: return nil
    default: return ReplayTarget(workspace: env.path, platform: device.platform, slot: device.slot)
    }
  }

  private func tile(_ device: DeviceRef, screenHeight: CGFloat, replay: ReplayController?, replaying: Bool)
    -> some View
  {
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
      viewer: true)
  }

  /// The device's own view takes Escape while it has the keyboard, so the key is caught before any view sees it.
  private func watchEscape() {
    let released = $takenOver
    escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [close] event in
      guard event.keyCode == 0x35, event.modifierFlags.intersection(.deviceIndependentFlagsMask).isEmpty else {
        return event
      }
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

/// Re-renders its content as the replay starts, stops or moves.
private struct ReplayingTile<Content: View>: View {
  @ObservedObject var replay: ReplayController
  @ViewBuilder var content: (Bool) -> Content

  var body: some View { content(replay.replay != nil) }
}
