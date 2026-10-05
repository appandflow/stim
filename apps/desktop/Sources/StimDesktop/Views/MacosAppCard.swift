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
      HStack {
        Label(app.product, systemImage: "macwindow")
          .font(.stim(.headline))
        Spacer()
        Button("Build and run") { actions.run("Build \(app.product)", StimCommand(runArguments, cwd: workspace)) }
          .nativeControlStyle()
          .disabled(app.build.state == "running" || actions.active(for: workspace) != nil)
        if app.host != nil {
          Button("Stop") { actions.run("Stop \(app.product)", StimCommand(["stop"], cwd: workspace)) }
            .nativeControlStyle(.destructive)
        } else if app.state == "running" || app.state == "orphaned" {
          Button("Refresh preview") { previewRequest += 1 }
            .nativeControlStyle()
            .disabled(refreshing)
          Button("Open app") { Task { await capture.openApp() } }
            .nativeControlStyle()
            .disabled(capture.image == nil || refreshing)
          Button("Stop") { actions.run("Stop \(app.product)", StimCommand(["stop"], cwd: workspace)) }
            .nativeControlStyle(.destructive)
        }
      }
      HStack {
        Text("Swift Package Debug \u{00B7} build \(app.build.state) \u{00B7} app \(app.state)\(hostNote)")
          .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        Spacer()
        if app.host == nil { Button("Permissions") { permissions.openSetup() }.nativeControlStyle() }
      }
      if let error = app.build.error { Text(error).foregroundStyle(Palette.error).textSelection(.enabled) }
      if app.host != nil {
        if app.state == "running" || app.state == "unverified" { HostedMacosWindow(app: app, workspace: workspace) }
      } else if let error = capture.error {
        Text(error).foregroundStyle(Palette.secondary).textSelection(.enabled)
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

  fileprivate var hostNote: String {
    guard let host = app.host else { return "" }
    return " on \(host.machine) as \(host.bundleId)"
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
          Text(controlNote ?? readOnly ?? "Window on \(app.host?.machine ?? "the host")")
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
          if let problem = stream.problem ?? (stream.receiving ? nil : "Connecting to \(app.host?.machine ?? "the host")") {
            PhysicalMessage(text: problem)
          }
        }
        .accessibilityLabel("\(app.product) window on \(app.host?.machine ?? "the host")")
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

@MainActor private final class MacosWindowCapture: NSObject, ObservableObject, SCStreamDelegate, SCStreamOutput {
  @Published var image: CGImage?
  @Published var error: String?
  private var stream: SCStream?
  private var app: MacosApp?
  private var window: SCWindow?
  private let context = CIContext()

  func start(_ app: MacosApp) async {
    await stop()
    error = nil
    guard !Task.isCancelled else { return }
    guard app.state == "running", matches(app) else { return }
    guard app.app?.pid != getpid() else {
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
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      guard !Task.isCancelled, self.app?.launchId == app.launchId, matches(app) else { return }
      let windows = content.windows.filter { $0.owningApplication?.processID == app.app?.pid && $0.windowLayer == 0 }
      let mainWindows = windows.filter { candidate in windows.allSatisfy { candidate.frame.contains($0.frame) } }
      guard mainWindows.count == 1, let window = mainWindows.first else {
        error = "This prototype needs one visible app window."
        return
      }
      self.window = window
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let configuration = SCStreamConfiguration()
      configuration.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded(.up))
      configuration.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded(.up))
      configuration.ignoreShadowsSingleWindow = true
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
      configuration.queueDepth = 3
      configuration.showsCursor = false
      let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
      self.stream = stream
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
      try await stream.startCapture()
    } catch { self.error = error.localizedDescription }
  }

  func stop() async {
    let old = stream
    stream = nil
    app = nil
    window = nil
    image = nil
    try? await old?.stopCapture()
  }

  nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
    Task { @MainActor in
      guard self.stream === stream else { return }
      self.stream = nil
      self.error = error.localizedDescription
      self.image = nil
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

  private func matches(_ app: MacosApp) -> Bool {
    guard let process = app.app else { return false }
    var info = proc_bsdinfo()
    guard
      proc_pidinfo(process.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        == MemoryLayout<proc_bsdinfo>.size,
      info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec == process.startedAtMicros,
      let running = NSRunningApplication(processIdentifier: process.pid),
      running.bundleIdentifier == app.bundleId,
      running.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: app.executable).resolvingSymlinksInPath().path
    else { return false }
    return true
  }

  func openApp() async {
    guard let app, matches(app), let window, stream != nil else { return }
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      let windows = content.windows.filter { $0.owningApplication?.processID == app.app?.pid && $0.windowLayer == 0 }
      guard self.app?.launchId == app.launchId, self.window?.windowID == window.windowID, stream != nil, matches(app),
        windows.contains(where: { $0.windowID == window.windowID && $0.frame.size == window.frame.size }),
        let process = app.app, let running = NSRunningApplication(processIdentifier: process.pid)
      else {
        error = "Open app needs the same single owned window."
        return
      }
      guard AXIsProcessTrusted() else {
        error = "Allow \(NativeViewerPermissions.shared.controlPermissionTitle) in Permissions to open the captured app window."
        return
      }
      let element = AXUIElementCreateApplication(process.pid)
      var value: CFTypeRef?
      guard AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &value) == .success,
        let owned = value as? [AXUIElement]
      else { return }
      var mainWindows: [AXUIElement] = []
      for own in owned {
        var subrole: CFTypeRef?
        guard AXUIElementCopyAttributeValue(own, kAXSubroleAttribute as CFString, &subrole) == .success else { return }
        if subrole as? String == kAXStandardWindowSubrole {
          mainWindows.append(own)
        } else if subrole as? String != kAXDialogSubrole {
          error = "Open app needs one standard app window."
          return
        }
      }
      var title: CFTypeRef?
      guard mainWindows.count == 1, let own = mainWindows.first,
        AXUIElementCopyAttributeValue(own, kAXTitleAttribute as CFString, &title) == .success, title as? String == window.title,
        matches(app)
      else {
        error = "Open app needs the captured standard window."
        return
      }
      guard running.activate(options: [])
      else {
        error = "The owned app could not be activated."
        return
      }
      error = nil
    } catch { self.error = error.localizedDescription }
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
