import AppKit
import CoreImage
import Darwin
import ScreenCaptureKit
import StimKit
import StimStores
import SwiftUI

struct MacosAppCard: View {
  var app: MacosApp
  var workspace: String
  @EnvironmentObject private var actions: ActionCenter
  @ObservedObject private var permissions = NativeViewerPermissions.shared
  @StateObject private var capture = MacosWindowCapture()
  @State private var refreshing = false
  @State private var previewRequest = 0

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.sm) {
        Label(app.product, systemImage: "macwindow")
          .font(.stim(.headline))
        Spacer()
        if app.host == nil, app.state == "running" || app.state == "orphaned" {
          IconButton(systemImage: "arrow.clockwise", help: "Refresh preview \u{2014} capture the app's window again") {
            previewRequest += 1
          }
          .disabled(refreshing)
          IconButton(
            systemImage: "arrow.up.forward.app",
            help: "Open app \u{2014} bring the captured window to the front for normal input"
          ) { Task { await capture.openApp() } }
          .disabled(capture.image == nil || refreshing)
        }
        if app.host != nil || app.state == "running" || app.state == "orphaned" {
          IconButton(systemImage: "stop.fill", tint: Palette.error, help: "Stop \u{2014} quit this workspace's app") {
            actions.run("Stop \(app.product)", StimCommand(["stop"], cwd: workspace))
          }
        }
        Button("Build and run", systemImage: "play.fill") {
          actions.run("Build \(app.product)", StimCommand(runArguments, cwd: workspace))
        }
        .nativeControlStyle(.primary)
        .disabled(app.build.state == "running" || actions.active(for: workspace) != nil)
      }
      HStack(spacing: Space.sm) {
        Text("Swift Package Debug \u{00B7} build \(app.build.state) \u{00B7} app \(app.state)")
          .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        Spacer()
        if app.host == nil, permissionsMissing {
          Button {
            permissions.openSetup()
          } label: {
            Label("Allow viewer permissions", systemImage: "exclamationmark.triangle.fill")
          }
          .buttonStyle(.borderless)
          .foregroundStyle(Palette.warning)
          .font(.stim(.footnote))
          .help("Viewing needs \(permissions.screenPermissionTitle); Open app also needs \(permissions.controlPermissionTitle).")
        }
      }
      if let host = app.host {
        Label("on \(machineName(host.machine))", systemImage: "desktopcomputer")
          .font(.stim(.footnote))
          .foregroundStyle(Palette.secondary)
          .lineLimit(1)
          .help("\(host.machine) \u{00B7} \(host.bundleId)")
      }
      if let error = app.build.error { Text(error).foregroundStyle(Palette.error).textSelection(.enabled) }
      if app.host != nil {
        if app.state == "running" || app.state == "unverified" { HostedMacosWindow(app: app, workspace: workspace) }
      } else if let error = capture.error {
        Text(error).foregroundStyle(Palette.secondary).textSelection(.enabled)
      }
      if app.host == nil, capture.image != nil, capture.windows.count > 1 || capture.pinned != nil {
        MacosWindowMenu(
          windows: capture.windows.map { MacosWindows.Window(id: Int($0.id), title: $0.title) },
          current: capture.current.map { Int($0.id) }, pinned: capture.pinned != nil, enabled: true
        ) { id in Task { await capture.select(id.map(UInt32.init)) } }
      }
      if app.host == nil, let image = capture.image {
        MacosWindowCanvas(image: image)
          .aspectRatio(CGFloat(image.width) / CGFloat(image.height), contentMode: .fit)
          .frame(maxWidth: .infinity)
          .accessibilityLabel("\(app.product) owned window")
      }
    }
    .padding(Space.lg)
    .background(RoundedRectangle(cornerRadius: Radius.card).fill(Palette.surface))
    .task(id: "\(app.launchId)|\(app.state)|\(previewRequest)") {
      refreshing = true
      await capture.start(app)
      if !Task.isCancelled { refreshing = false }
    }
    .onChange(of: permissions.revision) { previewRequest += 1 }
    .onDisappear {
      Task { await capture.stop() }
    }
  }
}

extension MacosAppCard {
  fileprivate var runArguments: [String] {
    guard let host = app.host else { return ["macos"] }
    return ["macos", "--host", host.machine]
  }

  fileprivate var permissionsMissing: Bool {
    _ = permissions.revision
    return !CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted()
  }
}

/// The window of an app that `stim macos --host` runs on another Mac, through this Mac's stim-server, which relays
/// frames and input to the host. Control takes clicks and typed text.
private struct HostedMacosWindow: View {
  var app: MacosApp
  var workspace: String
  @ObservedObject private var session = ServerSession.shared
  @StateObject private var stream: PhysicalStream
  @State private var controlling = false
  @State private var pixelSize: CGSize?

  init(app: MacosApp, workspace: String) {
    self.app = app
    self.workspace = workspace
    _stream = StateObject(
      wrappedValue: PhysicalStream(
        target: ReplayTarget(workspace: workspace, platform: "macos", slot: "default"), physical: false))
  }

  var body: some View {
    let screen = PhysicalScreen(hostedMacosOn: session.link)
    content(screen)
      .onChange(of: screen, initial: true) { _, screen in follow(screen) }
      .onChange(of: app.launchId) {
        controlling = false
        stream.stop()
        follow(screen)
      }
      .onChange(of: controlling) { _, controlling in
        if controlling { stream.begin() } else { stream.end() }
      }
      .onChange(of: stream.control) { _, control in
        switch control {
        case .off, .failed: controlling = false
        case .starting, .on: break
        }
      }
      .onDisappear { stream.stop() }
  }

  @ViewBuilder private func content(_ screen: PhysicalScreen) -> some View {
    switch screen {
    case .message(let text, let remedy):
      PhysicalMessage(text: text, remedy: remedy).frame(minHeight: 160)
    case .stream(let readOnly):
      VStack(alignment: .leading, spacing: Space.sm) {
        HStack {
          Text(controlNote ?? readOnly ?? "Window on \(machineName(app.host?.machine ?? "the host"))")
            .font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(2)
          Spacer()
          if stream.problem != nil {
            Button("Reconnect") {
              controlling = false
              stream.stop()
              follow(screen)
            }
            .nativeControlStyle()
          }
          if let windows = stream.windows, windows.windows.count > 1 || windows.pinned {
            MacosWindowMenu(
              windows: windows.windows, current: windows.current, pinned: windows.pinned,
              enabled: readOnly == nil && isControlling
            ) { stream.selectWindow($0) }
          }
          if readOnly == nil {
            Button(controlling ? "Release" : "Control") { controlling.toggle() }
              .nativeControlStyle()
          }
        }
        PhysicalDisplay(
          stream: stream, activityKey: nil, interactive: controlling && isControlling,
          onPixelSizeChange: { pixelSize = $0 }
        )
        .aspectRatio(pixelSize.map { $0.width / max($0.height, 1) } ?? 1.6, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .overlay {
          if let problem = stream.problem
            ?? (stream.receiving ? nil : "Connecting to \(machineName(app.host?.machine ?? "the host"))")
          {
            PhysicalMessage(text: problem)
          }
        }
        .accessibilityLabel("\(app.product) window on \(machineName(app.host?.machine ?? "the host"))")
      }
    }
  }

  private var isControlling: Bool {
    if case .on = stream.control { return true }
    return false
  }

  private var controlNote: String? {
    switch stream.control {
    case .starting: return "Taking control"
    case .failed(let message): return message
    case .off(ended: let ended?): return "Control ended. \(ended)"
    case .off, .on: return nil
    }
  }

  private func follow(_ screen: PhysicalScreen) {
    if case .stream = screen, session.isOpen {
      stream.connect(session.client)
    } else {
      stream.stop()
    }
  }
}

/// Chooses between following the app's front window and pinning the view to one of its windows.
private struct MacosWindowMenu: View {
  var windows: [MacosWindows.Window]
  var current: Int?
  var pinned: Bool
  var enabled: Bool
  var select: (Int?) -> Void

  var body: some View {
    Menu {
      Toggle("Follow front window", isOn: Binding(get: { !pinned }, set: { if $0 { select(nil) } }))
      Divider()
      ForEach(windows) { window in
        Toggle(
          title(window),
          isOn: Binding(get: { pinned && window.id == current }, set: { if $0 { select(window.id) } }))
      }
    } label: {
      Label(
        pinned ? "Pinned to \(currentTitle)" : "Following the front window, \(currentTitle)",
        systemImage: pinned ? "pin.fill" : "macwindow.on.rectangle")
    }
    .menuStyle(.borderlessButton)
    .font(.stim(.caption))
    .tint(Palette.secondary)
    .fixedSize()
    .disabled(!enabled)
    .help(
      enabled
        ? "Follow the app's front window, or pin the view to one window and bring it to the front."
        : "Take control to choose a window.")
  }

  private var currentTitle: String {
    windows.first { $0.id == current }.map(title) ?? "no window"
  }

  private func title(_ window: MacosWindows.Window) -> String {
    window.title.isEmpty ? "Untitled window" : window.title
  }
}

@MainActor private final class MacosWindowCapture: NSObject, ObservableObject, SCStreamDelegate, SCStreamOutput {
  @Published var image: CGImage?
  @Published var error: String?
  @Published var windows: [OwnedAppWindows.Window] = []
  @Published var current: OwnedAppWindows.Window?
  /// The window the preview stays on until it closes or the menu follows the front window again.
  @Published var pinned: UInt32?
  private var stream: SCStream?
  private var app: MacosApp?
  private var window: SCWindow?
  private var follower: Task<Void, Never>?
  private let context = CIContext()

  func start(_ app: MacosApp) async {
    await stop()
    error = nil
    guard !Task.isCancelled else { return }
    guard app.state == "running", matches(app), let pid = app.app?.pid else { return }
    guard pid != getpid() else {
      error = "This is the viewer app. View its window from another Stim Desktop instance or your phone."
      return
    }
    NativeViewerPermissions.shared.viewerOpened()
    guard CGPreflightScreenCaptureAccess() else {
      error =
        "Allow \(NativeViewerPermissions.shared.screenPermissionTitle) in Permissions to view this app. Status and logs remain available."
      return
    }
    self.app = app
    await follow(app)
    guard self.app?.launchId == app.launchId else { return }
    follower = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(500))
        guard !Task.isCancelled, let self else { return }
        await self.follow(app)
      }
    }
  }

  private func follow(_ app: MacosApp) async {
    guard self.app?.launchId == app.launchId, let pid = app.app?.pid else { return }
    let read = await Task.detached { Result { try OwnedAppWindowReader.selection(pid: pid) } }.value
    guard self.app?.launchId == app.launchId, matches(app) else { return }
    guard case .success(let read) = read else { return }
    guard let found = read else {
      windows = []
      current = nil
      image = nil
      error =
        AXIsProcessTrusted()
        ? "The app has no open window."
        : "Without \(NativeViewerPermissions.shared.controlPermissionTitle), the preview needs one visible app window."
      pinned = nil
      return
    }
    let pin = OwnedAppWindows.pin(found, to: pinned)
    let selection = pin.selection
    if pinned != pin.pinned { pinned = pin.pinned }
    if windows != selection.windows { windows = selection.windows }
    if stream != nil, let window, window.windowID == selection.current.id,
      window.frame.size == selection.current.frame.size
    {
      if current != selection.current { current = selection.current }
      return
    }
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      guard self.app?.launchId == app.launchId, matches(app),
        let next = content.windows.first(where: {
          $0.windowID == selection.current.id && $0.owningApplication?.processID == pid && $0.windowLayer == 0
        })
      else { return }
      let filter = SCContentFilter(desktopIndependentWindow: next)
      let configuration = SCStreamConfiguration()
      configuration.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded(.up))
      configuration.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded(.up))
      configuration.ignoreShadowsSingleWindow = true
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
      configuration.queueDepth = 3
      configuration.showsCursor = false
      if let stream {
        try await stream.updateContentFilter(filter)
        try await stream.updateConfiguration(configuration)
        guard self.app?.launchId == app.launchId, self.stream === stream else { return }
      } else {
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
        try await stream.startCapture()
        guard self.app?.launchId == app.launchId else {
          try? await stream.stopCapture()
          return
        }
        self.stream = stream
      }
      window = next
      current = selection.current
      error = nil
    } catch {
      if OwnedAppWindowReader.screen(pid: pid)?.contains(where: { $0.id == selection.current.id }) == true {
        self.error = error.localizedDescription
      }
    }
  }

  /// Pins the preview to window `id` and brings it to the front among the app's windows, or with nil follows the
  /// front window again.
  func select(_ id: UInt32?) async {
    guard let app, let pid = app.app?.pid, matches(app) else { return }
    pinned = nil
    if let id {
      let raised = await Task.detached { Self.raise(id, pid: pid) }.value
      guard raised, self.app?.launchId == app.launchId else { return }
      pinned = id
    }
    await follow(app)
  }

  private nonisolated static func raise(_ id: UInt32, pid: pid_t) -> Bool {
    guard AXIsProcessTrusted(), let screen = OwnedAppWindowReader.screen(pid: pid),
      let accessible = OwnedAppWindowReader.accessible(pid: pid),
      let index = OwnedAppWindows.select(screen: screen, accessible: accessible.windows)?.windows
        .first(where: { $0.id == id })?.accessible
    else { return false }
    let element = accessible.elements[index]
    let main = AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    return main == .success
  }

  func stop() async {
    follower?.cancel()
    follower = nil
    let old = stream
    stream = nil
    app = nil
    window = nil
    image = nil
    windows = []
    current = nil
    pinned = nil
    try? await old?.stopCapture()
  }

  nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(500))
      guard self.stream === stream, let pid = self.app?.app?.pid else { return }
      self.stream = nil
      self.image = nil
      if let id = self.window?.windowID, OwnedAppWindowReader.screen(pid: pid)?.contains(where: { $0.id == id }) == true {
        self.follower?.cancel()
        self.error = error.localizedDescription
      }
    }
  }

  nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    MainActor.assumeIsolated {
      guard self.stream === stream, type == .screen, let app else { return }
      guard matches(app) else {
        error = "The owned app process changed or exited."
        Task { await self.stop() }
        return
      }
      guard let buffer = sampleBuffer.imageBuffer
      else { return }
      image = context.createCGImage(
        CIImage(cvPixelBuffer: buffer),
        from: CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer)))
    }
  }

  // NSRunningApplication(processIdentifier:) returns nil for 1-2 ms at a time on macOS 27 while the process runs.
  private nonisolated static func runningApplication(_ pid: pid_t) -> NSRunningApplication? {
    for attempt in 0..<4 {
      if attempt > 0 { usleep(5_000) }
      if let running = NSRunningApplication(processIdentifier: pid) { return running }
    }
    return nil
  }

  private func matches(_ app: MacosApp) -> Bool {
    guard let process = app.app else { return false }
    var info = proc_bsdinfo()
    guard
      proc_pidinfo(process.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        == MemoryLayout<proc_bsdinfo>.size,
      info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec == process.startedAtMicros,
      let running = Self.runningApplication(process.pid),
      running.bundleIdentifier == app.bundleId,
      running.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: app.executable).resolvingSymlinksInPath().path
    else { return false }
    return true
  }

  func openApp() async {
    guard let app, matches(app), let window, stream != nil, let process = app.app,
      let running = Self.runningApplication(process.pid)
    else { return }
    guard AXIsProcessTrusted() else {
      error = "Allow \(NativeViewerPermissions.shared.controlPermissionTitle) in Permissions to open the captured app window."
      return
    }
    let pinned = pinned
    let captured = window.windowID
    let raised = await Task.detached { () -> Bool in
      if let pinned { return Self.raise(pinned, pid: process.pid) }
      return (try? OwnedAppWindowReader.selection(pid: process.pid))?.current.id == captured
    }.value
    guard raised, self.app?.launchId == app.launchId, self.window?.windowID == window.windowID, matches(app) else {
      error = "Open app needs the captured window."
      return
    }
    guard running.activate(options: [])
    else {
      error = "The owned app could not be activated."
      return
    }
    error = nil
  }
}

private struct MacosWindowCanvas: NSViewRepresentable {
  var image: CGImage

  func makeNSView(context: Context) -> Canvas { Canvas() }
  func updateNSView(_ view: Canvas, context: Context) {
    view.image = image
    view.needsDisplay = true
  }

  final class Canvas: NSView {
    var image: CGImage?
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
      guard let image, let context = NSGraphicsContext.current?.cgContext else { return }
      context.saveGState()
      context.translateBy(x: 0, y: bounds.height)
      context.scaleBy(x: 1, y: -1)
      context.draw(image, in: bounds)
      context.restoreGState()
    }
  }
}
