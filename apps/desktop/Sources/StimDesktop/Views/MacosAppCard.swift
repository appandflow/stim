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
        Button("Build and run") { actions.run("Build \(app.product)", StimCommand(["macos"], cwd: workspace)) }
          .nativeControlStyle()
          .disabled(app.build.state == "running" || actions.active(for: workspace) != nil)
        if app.state == "running" || app.state == "orphaned" {
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
        Text("Swift Package Debug \u{00B7} build \(app.build.state) \u{00B7} app \(app.state)")
          .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        Spacer()
        Button("Permissions") { permissions.openSetup() }.nativeControlStyle()
      }
      if let error = app.build.error { Text(error).foregroundStyle(Palette.error).textSelection(.enabled) }
      if let error = capture.error { Text(error).foregroundStyle(Palette.secondary).textSelection(.enabled) }
      if let image = capture.image {
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
