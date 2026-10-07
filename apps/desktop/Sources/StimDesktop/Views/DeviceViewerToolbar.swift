import AppKit
import StimKit
import StimStores
import SwiftUI

struct DeviceViewerToolbar: View {
  var device: DeviceRef
  var env: Workspace
  var usage: WorkspaceUsage?
  @Binding var takenOver: Bool
  var replaying: Bool
  /// Whether the agent action list is shown; nil when the device has none or the sheet is too narrow for it.
  var showsActions: Binding<Bool>?
  @Binding var scalingMode: DeviceScalingMode
  var scalingModes: [DeviceScalingMode]
  var close: () -> Void
  @State private var confirmingStop = false
  @EnvironmentObject private var actions: ActionCenter
  @ObservedObject private var server = ServerSession.shared

  var body: some View {
    HStack(spacing: Space.md) {
      identity
        .layoutPriority(1)
      if let machine = device.hostedMachine {
        Label("on \(machineName(machine))", systemImage: "desktopcomputer")
          .font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
      ViewThatFits(in: .horizontal) {
        status(usage: true)
        status(usage: false)
        EmptyView()
      }
      Spacer(minLength: Space.md)
      if scalingModes.count > 1 {
        Menu {
          ForEach(DeviceScalingMode.allCases, id: \.self) { mode in
            Toggle(mode.rawValue, isOn: Binding(get: { scalingMode == mode }, set: { _ in scalingMode = mode }))
              .disabled(!scalingModes.contains(mode))
          }
        } label: {
          Label(scalingMode.rawValue, systemImage: "arrow.up.left.and.arrow.down.right")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Fit adapts to the viewer. Accurate modes keep their scale; scroll to see the rest of a large device.")
        .accessibilityLabel("Device scale: \(scalingMode.rawValue)")
      }
      commands
      Rectangle().fill(Palette.border).frame(width: 1, height: 18)
      if let showsActions {
        Button(
          showsActions.wrappedValue ? "Hide agent actions" : "Show agent actions", systemImage: "sidebar.trailing"
        ) {
          showsActions.wrappedValue.toggle()
        }
        .labelStyle(.iconOnly)
        .nativeIconStyle()
        .help(showsActions.wrappedValue ? "Hide the agent actions" : "Show the agent actions")
        .accessibilityAddTraits(showsActions.wrappedValue ? .isSelected : [])
      }
      Button("Close", systemImage: "xmark", action: close)
        .labelStyle(.iconOnly)
        .nativeIconStyle()
        .help(takenOver ? "Close the viewer and release the device (Escape releases first)" : "Close (Escape)")
    }
    .font(.stim(.footnote, weight: .medium))
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private var identity: some View {
    HStack(spacing: Space.sm) {
      StatusDot(
        color: device.isRunning ? Palette.success : Palette.tertiary, filled: device.isRunning,
        label: "State: \(device.state)"
      )
      .help("State: \(device.state)")
      Text(device.label).font(.stim(.callout, weight: .semibold))
      if let detail = device.detail {
        Text(detail).font(.stim(.callout)).foregroundStyle(Palette.secondary)
      }
      Text("\u{00B7}").font(.stim(.callout)).foregroundStyle(Palette.tertiary).accessibilityHidden(true)
      Text(env.names.title)
        .font(.stim(.callout))
        .foregroundStyle(Palette.secondary)
        .truncationMode(.middle)
        .help("Workspace \(env.path)")
    }
    .lineLimit(1)
    .help([device.label, device.detail, source].compactMap { $0 }.joined(separator: " \u{00B7} "))
  }

  private func status(usage showsUsage: Bool) -> some View {
    HStack(spacing: Space.sm) {
      TimelineView(.periodic(from: .now, by: 30)) { context in
        if let badge = ActivityBadge(
          device.activity, screenChangedAt: device.activityKey.flatMap(ScreenActivity.shared.lastChange),
          now: context.date)
        {
          activityPill(badge)
        }
      }
      if device.appStopped, env.appPresence(device) != AppPresence.none {
        Pill(tone: .warning) { Text("App not running") }
          .help("stim status sees no \(device.app?.id ?? "app") process on this device.")
      }
      if case .web(let browser) = device, browser.pageFailed {
        Pill(tone: .warning) { Text("Page failed to load") }
          .help(browser.page?.error ?? "The page's latest load failed.")
      }
      if device.isPhysical {
        Pill { Text("Physical") }
          .help(
            device.platform == "ios"
              ? "A device Stim uses through this workspace's lease and never owns. Its screen is view only."
              : "A device Stim uses through this workspace's lease and never owns.")
        if let expires = device.leaseExpiresAt {
          TimelineView(.periodic(from: .now, by: 30)) { context in
            Pill("Leased \u{00B7} \(Format.duration(expires.timeIntervalSince(context.date))) left")
              .help("This workspace's lease ends at \(expires.formatted(date: .omitted, time: .shortened)).")
          }
        }
      }
      if case .remote = device {
        Pill(tone: .warning) { Text("billable") }
          .help("This remote session is billed while it runs.")
      }
      if showsUsage, let usage, !usage.isEmpty {
        HStack(spacing: Space.md) { UsageFigures(usage: usage) }
          .font(.stim(.caption))
          .accessibilityElement(children: .combine)
      }
    }
    .fixedSize()
  }

  @ViewBuilder private func activityPill(_ badge: ActivityBadge) -> some View {
    let basis = device.activity.map { "stim status activity: \($0.basis.joined(separator: ", "))" } ?? ""
    switch badge {
    case .driven:
      Pill(tone: .brand) {
        StatusDot(color: Palette.primary)
        Text(badge.text)
      }
      .help([badge.text, basis].joined(separator: "\n"))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(badge.text)
    case .idle:
      Pill(tone: .neutral) { Text(badge.text) }.help(basis)
    case .unknown:
      Pill(tone: .warning) { Text(badge.text) }.help(basis)
    }
  }

  private var source: String {
    switch device {
    case .ios(_, let d): return d.physical ? "iOS device" : "iOS Simulator"
    case .android(_, let d): return d.physical ? "Android device" : "Android Emulator"
    case .remote(let d): return d.backend == "eas" ? "EAS Simulator" : "Remote device"
    case .web(let d): return d.headless ? "Chrome, headless" : "Chrome"
    }
  }

  @ViewBuilder private var commands: some View {
    let busy = actions.active(for: env.path) != nil
    if device.appStopped, let run = runCommand(for: device, cwd: env.path) {
      Button("Run", systemImage: "play.fill") {
        actions.run("Run on \(platformName(device.platform))", steps: [run], present: false)
      }
      .nativeControlStyle(.primary)
      .fixedSize()
      .disabled(busy || env.runningBuild(for: device) != nil)
      .help((["stim"] + run.arguments).joined(separator: " "))
    }
    takeOverButton
    if case .remote = device {
      remoteStop(busy: busy)
    } else if case .web(let browser) = device {
      webControls(browser, busy: busy)
    } else if device.isRunning, !device.isPhysical {
      Button("Stop") {
        actions.run("Stop \(device.slot)", steps: [stopCommand(for: device, cwd: env.path)], present: false)
      }
      .nativeIconStyle(tint: Palette.error)
      .fixedSize()
      .disabled(busy)
      .help(
        "stim stop --slot \(device.slot): stops every device in this slot, keeping the shared server and other slots running"
      )
    }
  }

  @ViewBuilder private var takeOverButton: some View {
    if device.isInteractive,
      (!device.isPhysical && device.hostedMachine == nil) || takenOver
        || PhysicalScreen(device: device, link: server.link, now: Date()).canControl
    {
      if takenOver {
        Button("Release control", systemImage: "hand.raised.fill") { takenOver = false }
          .nativeIconStyle()
          .fixedSize()
          .help("Release control so an agent can drive this device again (Escape).")
          .accessibilityLabel("Release control")
      } else {
        Button("Control", systemImage: "cursorarrow.rays") { takenOver = true }
          .tutorialAnchor(.viewerControl, workspace: env.path)
          .accessibilityLabel("Control device")
          .nativeIconStyle()
          .fixedSize()
          .disabled(replaying)
          .help(
            replaying
              ? "Go live to control this device."
              : "Control: send your clicks, trackpad scrolls and keys to this device. If an agent is driving it, controlling it may disrupt it."
          )
      }
    }
  }

  private func remoteStop(busy: Bool) -> some View {
    Button("Stop") { confirmingStop = true }
      .nativeIconStyle(tint: Palette.error)
      .fixedSize()
      .disabled(busy)
      .help("stim stop: ends the remote session with the rest of the workspace")
      .confirmationDialog("Stop this workspace?", isPresented: $confirmingStop, titleVisibility: .visible) {
        Button("Run stim stop", role: .destructive) {
          actions.run("Stop \(env.names.title)", steps: [StimCommand(["stop"], cwd: env.path)], present: false)
        }
      } message: {
        Text(
          "stim stop ends the billable remote session and halts the workspace's dev server and devices. The session cannot be resumed."
        )
      }
  }

  @ViewBuilder private func webControls(_ browser: WebBrowser, busy: Bool) -> some View {
    if let url = URL(string: browser.currentURL), ["http", "https"].contains(url.scheme) {
      Button("Open in browser", systemImage: "safari") { NSWorkspace.shared.open(url) }
        .labelStyle(.iconOnly)
        .nativeIconStyle()
        .help("Open \(browser.currentURL) in your default browser. Stim's Chrome and its profile are not involved.")
    }
    if browser.running {
      Button("Reload", systemImage: "arrow.clockwise") {
        actions.run("Reload web", steps: [StimCommand(["reload", "web"], cwd: env.path)], present: false)
      }
      .labelStyle(.iconOnly)
      .nativeIconStyle()
      .disabled(busy)
      .help("stim reload web: reloads the page in Stim's Chrome")
      Button("Close") { actions.run("Close web", steps: [stopCommand(for: device, cwd: env.path)], present: false) }
        .nativeIconStyle(tint: Palette.error)
        .fixedSize()
        .disabled(busy)
        .help("stim stop --slot web: closes Stim's Chrome and keeps its profile, Metro and every device")
    }
  }
}
