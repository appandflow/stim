import AppKit
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
  /// The device viewer shows the window large and live; a preview tile shows it small and slower.
  var viewer: Bool
  var onPointSizeChange: (CGSize) -> Void
  @ObservedObject private var permissions = NativeViewerPermissions.shared
  @StateObject private var capture = MacosWindowCapture()
  @State private var previewRequest = 0

  var body: some View {
    ZStack {
      MacosWindowCanvas(capture: capture)
        .opacity(capture.hasFrame ? 1 : 0)
        .accessibilityLabel("\(app.name) owned window")
        .accessibilityHidden(!capture.hasFrame)
      if !capture.hasFrame {
        if let error = capture.error {
          ScreenMessage(text: error)
        } else {
          ScreenMessage(text: "Connecting to \(app.name)")
        }
      }
      if capture.hasFrame, permissionsMissing {
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
    .onChange(of: capture.current?.frame.size, initial: true) { _, size in
      if let size { onPointSizeChange(size) }
    }
    .onChange(of: viewer, initial: true) { _, viewer in capture.viewer = viewer }
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
  @Published var hasFrame = false
  @Published var error: String?
  @Published var windows: [OwnedAppWindows.Window] = []
  @Published var current: OwnedAppWindows.Window?
  /// The window the preview stays on until it closes or the menu follows the front window again.
  @Published var pinned: UInt32?
  let layer = CALayer()
  var viewer = false {
    didSet { if viewer != oldValue { refollow() } }
  }
  private var shown = Shown()
  private var stream: SCStream?
  private var filter: SCContentFilter?
  private var plan: MacosCapturePlan?
  private var displayed: Frame?
  private var app: MacosApp?
  private var window: SCWindow?
  private var follower: Task<Void, Never>?
  private var pending: Task<Void, Never>?
  private var following = false
  private var followAgain = false
  private var retryAt: ContinuousClock.Instant?
  private let frames = DispatchQueue(label: "dev.stim.desktop.macos-window-frames", qos: .userInteractive)

  private struct Shown: Equatable {
    var size = CGSize.zero
    var scale: CGFloat = 2
    var visible = true
  }

  private struct Frame: @unchecked Sendable {
    var buffer: CVPixelBuffer
    var surface: IOSurfaceRef
    var source: SCStream
  }

  override init() {
    super.init()
    layer.contentsGravity = .resizeAspect
  }

  func show(size: CGSize, scale: CGFloat, visible: Bool) {
    let next = Shown(size: size, scale: scale, visible: visible)
    guard next != shown else { return }
    shown = next
    refollow()
  }

  private func refollow() {
    pending?.cancel()
    pending = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(250))
      guard !Task.isCancelled, let self, let app = self.app else { return }
      await self.follow(app)
    }
  }

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
    guard !following else {
      followAgain = true
      return
    }
    following = true
    var next: MacosApp? = app
    while let app = next {
      followAgain = false
      await followOnce(app)
      next = followAgain ? self.app : nil
    }
    following = false
  }

  private func followOnce(_ app: MacosApp) async {
    guard self.app?.launchId == app.launchId, let pid = app.app?.pid else { return }
    guard shown.visible else {
      await pause()
      return
    }
    if stream == nil, let retryAt, ContinuousClock.now < retryAt { return }
    let read = await Task.detached { Result { try OwnedAppWindowReader.selection(pid: pid) } }.value
    guard self.app?.launchId == app.launchId else { return }
    guard matches(app) else {
      if stream != nil || hasFrame {
        error = "The owned app process changed or exited."
        await stop()
      }
      return
    }
    guard case .success(let read) = read else { return }
    guard let found = read else {
      windows = []
      current = nil
      clearFrame()
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
      await updatePlan()
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
      guard let plan = plan(for: filter) else { return }
      let configuration = Self.configuration(plan)
      if let stream {
        try await stream.updateContentFilter(filter)
        try await stream.updateConfiguration(configuration)
        guard self.app?.launchId == app.launchId, self.stream === stream else { return }
      } else {
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: frames)
        try await stream.startCapture()
        guard self.app?.launchId == app.launchId, shown.visible else {
          try? await stream.stopCapture()
          return
        }
        self.stream = stream
      }
      self.filter = filter
      self.plan = plan
      retryAt = nil
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

  private func plan(for filter: SCContentFilter) -> MacosCapturePlan? {
    MacosCapturePlan.make(
      window: filter.contentRect.size, nativeScale: CGFloat(filter.pointPixelScale), shown: shown.size,
      backingScale: shown.scale, viewer: viewer, maxFramesPerSecond: AppPreferences.maxFramesPerSecond)
  }

  private static func configuration(_ plan: MacosCapturePlan) -> SCStreamConfiguration {
    let configuration = SCStreamConfiguration()
    configuration.width = plan.width
    configuration.height = plan.height
    configuration.ignoreShadowsSingleWindow = true
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(plan.framesPerSecond))
    configuration.queueDepth = 3
    configuration.showsCursor = false
    return configuration
  }

  private func updatePlan() async {
    guard let stream, let filter, let next = plan(for: filter), next != plan else { return }
    guard (try? await stream.updateConfiguration(Self.configuration(next))) != nil, self.stream === stream else { return }
    plan = next
  }

  private func pause() async {
    guard let old = stream else { return }
    stream = nil
    filter = nil
    plan = nil
    window = nil
    try? await old.stopCapture()
  }

  private func clearFrame() {
    hasFrame = false
    displayed = nil
    layer.contents = nil
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
    pending?.cancel()
    pending = nil
    let old = stream
    stream = nil
    filter = nil
    plan = nil
    app = nil
    window = nil
    clearFrame()
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
      self.filter = nil
      self.plan = nil
      self.clearFrame()
      if let id = self.window?.windowID, OwnedAppWindowReader.screen(pid: pid)?.contains(where: { $0.id == id }) == true {
        self.retryAt = .now.advanced(by: .seconds(5))
        self.error = error.localizedDescription
      }
    }
  }

  nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, Self.isComplete(sampleBuffer), let buffer = sampleBuffer.imageBuffer,
      let surface = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue()
    else { return }
    let frame = Frame(buffer: buffer, surface: surface, source: stream)
    DispatchQueue.main.async {
      MainActor.assumeIsolated { self.display(frame) }
    }
  }

  // ScreenCaptureKit marks frames that repeat the previous content as idle, without new pixels.
  private nonisolated static func isComplete(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let raw = attachments.first?[.status] as? Int
    else { return false }
    return SCFrameStatus(rawValue: raw) == .complete
  }

  private func display(_ frame: Frame) {
    guard stream === frame.source else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.contents = frame.surface
    CATransaction.commit()
    displayed = frame
    if !hasFrame { hasFrame = true }
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
  var capture: MacosWindowCapture

  func makeNSView(context: Context) -> Canvas {
    let view = Canvas()
    view.capture = capture
    return view
  }

  func updateNSView(_ view: Canvas, context: Context) { view.capture = capture }

  final class Canvas: NSView {
    weak var capture: MacosWindowCapture? {
      didSet {
        guard capture !== oldValue else { return }
        oldValue?.layer.removeFromSuperlayer()
        if let capture { layer?.addSublayer(capture.layer) }
        needsLayout = true
      }
    }

    override init(frame: NSRect) {
      super.init(frame: frame)
      wantsLayer = true
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
      super.layout()
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      capture?.layer.frame = bounds
      CATransaction.commit()
      report()
    }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: nil)
      if let window {
        NotificationCenter.default.addObserver(
          self, selector: #selector(occlusionChanged), name: NSWindow.didChangeOcclusionStateNotification, object: window)
      }
      report()
    }

    override func viewDidChangeBackingProperties() {
      super.viewDidChangeBackingProperties()
      report()
    }

    @objc private func occlusionChanged() { report() }

    private func report() {
      guard let capture else { return }
      let visible =
        window.map { !AppPreferences.pausesHiddenFrames || $0.occlusionState.contains(.visible) } ?? false
      capture.show(size: bounds.size, scale: window?.backingScaleFactor ?? 2, visible: visible)
    }
  }
}
