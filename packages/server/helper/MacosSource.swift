import AppKit
import CoreImage
import Darwin
import ScreenCaptureKit

final class MacosSource: NSObject, Source, SCStreamDelegate, SCStreamOutput {
  struct OwnedApp: Decodable {
    struct Process: Decodable {
      let pid: Int32
      let startedAtMicros: UInt64
    }
    let bundle: String
    let bundleId: String
    let executable: String
    let app: Process
  }

  private let app: OwnedApp
  private let pacer: Pacer
  private let video = videoEncoder()
  private let jpegGate = JpegGate()
  private var stream: SCStream?
  private var pixels: CVPixelBuffer?
  private var ownershipTimer: DispatchSourceTimer?

  init(app: OwnedApp) {
    self.app = app
    var render: (Config) -> Void = { _ in }
    pacer = Pacer { render($0) }
    super.init()
    render = { [unowned self] config in self.render(config) }
  }

  func start() {
    guard matches() else { fail("The owned macOS app process changed or exited.") }
    guard CGPreflightScreenCaptureAccess() else {
      fail(
        "Screen Recording access is unavailable for stim-frames. Allow the existing capture host in System Settings > Privacy & Security > Screen & System Audio Recording, then reconnect. Stim does not request or reset permissions; status and logs remain available."
      )
    }
    Task { [self] in
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard self.matches() else { fail("The owned macOS app process changed or exited.") }
        let windows = content.windows.filter {
          $0.owningApplication?.processID == self.app.app.pid
            && $0.owningApplication?.bundleIdentifier == self.app.bundleId && $0.windowLayer == 0
        }
        let mainWindows = windows.filter { candidate in
          windows.allSatisfy { candidate.windowID == $0.windowID || candidate.frame.contains($0.frame) }
        }
        guard mainWindows.count == 1, let window = mainWindows.first else {
          fail(
            "Open one visible window in the owned macOS app to view it. Stim does not capture the desktop or choose between app windows."
          )
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded(.up))
        configuration.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded(.up))
        configuration.ignoreShadowsSingleWindow = true
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.queueDepth = 3
        configuration.showsCursor = false
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        self.stream = stream
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.pacer.queue)
        try await stream.startCapture()
        let timer = DispatchSource.makeTimerSource(queue: self.pacer.queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
          guard let self else { return }
          if !self.matches() { fail("The owned macOS app process changed or exited.") }
        }
        self.ownershipTimer = timer
        timer.resume()
      } catch { fail("Owned macOS window capture failed: \(error.localizedDescription)") }
    }
  }

  func configure(_ config: Config) {
    video.configure(enabled: config.video, maxEdge: config.maxEdge, fps: Int(config.fps), bitrate: config.bitrate)
    pacer.queue.async {
      self.pacer.config = config
      self.pacer.changed()
    }
  }

  func keyframe() {
    video.requestKeyframe()
    pacer.changed()
  }

  func recordKeyframe() {}

  func input(_ command: Command) {
    Output.notice(["inputError": "Native macOS app windows are view-only."])
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("Owned macOS window capture stopped: \(error.localizedDescription)")
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, let buffer = sampleBuffer.imageBuffer else { return }
    guard matches() else { fail("The owned macOS app process changed or exited.") }
    pixels = buffer
    pacer.changed()
  }

  private func render(_ config: Config) {
    guard matches() else { fail("The owned macOS app process changed or exited.") }
    guard let pixels else { return }
    if config.video { video.encode(pixels, quarterTurns: 0, capturedAt: now()) }
    if config.jpeg, jpegGate.admit(config, pacer: pacer),
      let (data, width, height) = jpeg(CIImage(cvPixelBuffer: pixels), config: config)
    {
      Output.frame(jpeg: data, width: width, height: height)
    }
  }

  private func matches() -> Bool {
    var info = proc_bsdinfo()
    guard app.app.pid > 0,
      proc_pidinfo(app.app.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        == MemoryLayout<proc_bsdinfo>.size,
      info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec == app.app.startedAtMicros,
      let running = NSRunningApplication(processIdentifier: app.app.pid),
      running.bundleIdentifier == app.bundleId,
      running.executableURL?.resolvingSymlinksInPath().path
        == URL(fileURLWithPath: app.executable).resolvingSymlinksInPath().path,
      running.bundleURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: app.bundle).resolvingSymlinksInPath().path
    else { return false }
    return true
  }
}
