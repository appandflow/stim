import AppKit
import CoreImage
import Darwin
import ScreenCaptureKit
import StimKit
import StimStores
import SwiftUI

/// The windows of a `stim macos` app that its tile's menu lists, from this Mac's capture or from a hosted stream.
@MainActor final class MacosWindowChoice: ObservableObject {
  @Published var windows: [MacosWindows.Window] = []
  @Published var current: Int?
  @Published var pinned = false
  /// Whether the menu may change the window: always for a local app, only under control for a hosted one.
  @Published var canSelect = false
  /// Whether the menu may bring the app's window to the front of this Mac.
  @Published var canOpen = false
  var select: (Int?) -> Void = { _ in }
  var open: () -> Void = {}
}

/// The window of a `stim macos` app running on this Mac, captured with ScreenCaptureKit.
struct MacosLocalScreen: View {
  var app: MacosApp
  var choice: MacosWindowChoice
  var onPointSizeChange: (CGSize) -> Void
  @ObservedObject private var permissions = NativeViewerPermissions.shared
  @StateObject private var capture = MacosWindowCapture()
  @State private var previewRequest = 0
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    ZStack {
      if let image = capture.image {
        MacosWindowCanvas(image: image)
          .accessibilityLabel("\(app.product) owned window")
      } else if let error = capture.error {
        ScreenMessage(text: error)
      } else {
        ScreenMessage(text: "Connecting to \(app.product)")
      }
      if capture.image != nil, permissionsMissing {
        VStack {
          Spacer()
          Button {
            permissions.openSetup()
          } label: {
            Label("Allow Viewer Permissions", systemImage: "exclamationmark.triangle.fill")
          }
          .buttonStyle(.borderless)
          .foregroundStyle(Palette.warning)
          .font(.stim(.footnote))
          .padding(Space.sm)
        }
      }
    }
    .task(id: "\(app.launchId)|\(app.state)|\(previewRequest)") {
      choice.select = { id in Task { await capture.select(id.map(UInt32.init)) } }
      choice.open = { Task { await capture.openApp() } }
      await capture.start(app)
    }
    .onChange(of: permissions.revision) { previewRequest += 1 }
    .onChange(of: capture.windows, initial: true) { _, windows in
      choice.windows = windows.map { MacosWindows.Window(id: Int($0.id), title: $0.title) }
    }
    .onChange(of: capture.current, initial: true) { _, current in
      choice.current = current.map { Int($0.id) }
      choice.canOpen = current != nil
    }
    .onChange(of: capture.pinned, initial: true) { _, pinned in choice.pinned = pinned != nil }
    .onChange(of: capture.image.map { CGSize(width: $0.width, height: $0.height) }, initial: true) { _, pixels in
      guard let pixels else { return }
      onPointSizeChange(
        capture.current?.frame.size ?? CGSize(width: pixels.width / displayScale, height: pixels.height / displayScale))
    }
    .onAppear { choice.canSelect = true }
    .onDisappear {
      choice.windows = []
      choice.canOpen = false
      choice.canSelect = false
      Task { await capture.stop() }
    }
  }

  private var permissionsMissing: Bool {
    _ = permissions.revision
    return !CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted()
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
  private var retryAt: ContinuousClock.Instant?
  private let context = CIContext()

  func start(_ app: MacosApp) async {
    await stop()
    error = nil
    guard !Task.isCancelled else { return }
    guard app.state == "running", matches(app), let pid = app.app?.pid else { return }
    guard pid != getpid() else {
      error = PhoneApp.Copy.viewerAppError(phoneApp: FeatureFlags.isEnabled(.phoneApp))
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
    if stream == nil, let retryAt, ContinuousClock.now < retryAt { return }
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
    let pin = OwnedAppWindows.pin(found, to: pinned, screen: pinned == nil ? [] : OwnedAppWindowReader.screen(pid: pid) ?? [])
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
      let scale = min(CGFloat(filter.pointPixelScale), 1280 / max(filter.contentRect.width, 1))
      configuration.width = Int((filter.contentRect.width * scale).rounded(.up))
      configuration.height = Int((filter.contentRect.height * scale).rounded(.up))
      configuration.ignoreShadowsSingleWindow = true
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 5)
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
        retryAt = .now.advanced(by: .seconds(5))
      }
    }
  }

  /// Pins the preview to window `id` and brings it to the front among the app's windows, or with nil follows the
  /// front window again.
  func select(_ id: UInt32?) async {
    guard let app, let pid = app.app?.pid, matches(app) else { return }
    if let id {
      let raised = await Task.detached { Self.raise(id, pid: pid) }.value
      guard raised, self.app?.launchId == app.launchId else { return }
    }
    pinned = id
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
    let raise = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    return main == .success || raise == .success
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
        self.retryAt = .now.advanced(by: .seconds(5))
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
