import CoreImage
import CoreVideo
import Foundation
import IOSurface
import ImageIO

// stim-frames streams one device's screen as JPEG frames for stim-server.
//
//   stim-frames ios <udid>
//   stim-frames android <serial> [owned-avd-name]
//   stim-frames android-device <serial> <adb> <scrcpy-server>
//   stim-frames web <cdpEndpoint> <chromePid> <targetId>
//   stim-frames macos <owned-app-json>
//   stim-frames iphone <udid> [name]
//
// android-device streams any adb device through the scrcpy server jar at <scrcpy-server>,
// decoding its H.264 to re-encode it here; stim-server uses it for physical devices.
// It takes touch, text and the home, back, app-switch and lock buttons, and does not
// rotate or fold. It cleans up the device before any exit.
// A web page streams Chrome's screencast of the owned page: its JPEGs pass through as
// frames and are decoded for video. Input on a page takes touch, text and the "back"
// button, as DevTools input events. A USB-cabled iPhone streams its screen and takes no input.
// stdin takes one JSON object per line: {"fps": n, "maxEdge": px, "quality": 0-1,
// "jpeg": bool, "jpegFps": n, "video": bool, "bitrate": bits per second, "record":
// {"maxEdge": px, "fps": n, "bitrate": bits per second}}, where fps 0 pauses frames and
// "record", present only while stim-server records the device, runs a second encoder for it
// at no more than its own fps; {"recordKeyframe": true} makes that encoder's next frame a keyframe; {"keyframe": true} to make the next video frame a keyframe; or an input:
// {"input": "touch", "phase": "down|move|up", "x": 0-1, "y": 0-1, "display": n} with x
// and y on the upright screen; {"input": "text", "text": s}, printable ASCII where "\n"
// is Return, "\t" is Tab and "\u{8}" is Delete; and {"input": "button", "button":
// "home|lock"}, or on an emulator also "back|app-switch"; {"input": "rotate", "direction":
// "left|right"}; and on an emulator {"input": "posture", "posture":
// "folded|half-open|unfolded"}. An emulator types and presses buttons only with a hardware
// keyboard.
// stdout carries messages framed as a 4-byte big-endian length, then a kind byte:
// 1 is a frame (2-byte width, 2-byte height, JPEG bytes), 2 is a JSON notice
// ({"error": message} before a failed exit, {"inputError": message}, on a simulator
// with several displays {"display": n} when display n is the one lit and streamed, or
// on an emulator {"keyboard": "yes|no"} once it reports its hardware, or on an iPhone
// {"stalled": message} while frames cannot arrive and {"stalled": null} once they can), 3 is an H.264 access unit (1-byte
// flags with bit 0 set on a keyframe, 8-byte big-endian float capture time in
// milliseconds since the epoch, 2-byte width, 2-byte height, Annex-B bytes), and 4 is an
// access unit of the recording encoder, laid out like 3. Kind 5 adds a clockwise artwork
// quarter-turn byte after the frame dimensions. Live video bit 5 marks that rotation
// in bits 3-4; recordings omit it. The deviceFrame config requests PNG artwork notices.
// The helper exits when stdin closes.

struct Config: Equatable {
  var fps = 5.0
  var maxEdge = 1280
  var quality = 0.7
  var jpeg = true
  var jpegFps: Double?
  var video = false
  var deviceFrame = false
  var duoFrame: DuoCapture?
  var bitrate = 3_000_000
  var record: Recording?
}

struct Recording: Equatable {
  var maxEdge: Int
  var fps: Double
  var bitrate: Int
}

struct DuoCapture: Equatable {
  var maxEdge: Int
  var fps: Double
}

enum Output {
  private static let writer = DispatchQueue(label: "stim.frames.output")
  private static let lock = NSLock()
  private static var writing = false
  private static var writingDuo = false
  private static var pendingVideo = 0
  private static var videoNeedsKeyframe = false
  private static var keyframeRequested = false
  private static let maxPendingVideo = 30
  static var requestKeyframe: () -> Void = {}

  static func frame(jpeg: Data, width: Int, height: Int, artworkTurns: Int? = nil) {
    lock.lock()
    defer { lock.unlock() }
    guard !writing else { return }
    writing = true
    var body = Data([
      artworkTurns == nil ? 1 : 5, UInt8(width >> 8), UInt8(width & 0xff), UInt8(height >> 8), UInt8(height & 0xff),
    ])
    if let artworkTurns { body.append(UInt8(artworkTurns)) }
    body += jpeg
    writer.async {
      write(body)
      lock.lock()
      writing = false
      lock.unlock()
    }
  }

  static func duoFrame(_ frame: DuoFrameRenderer.Frame) {
    guard
      let metadata = try? JSONSerialization.data(withJSONObject: [
        "width": frame.width, "height": frame.height, "revision": frame.revision,
        "screenID": frame.screenID, "angle": frame.angle, "orientation": frame.orientation,
      ]), metadata.count <= 65535
    else { return }
    lock.lock()
    defer { lock.unlock() }
    guard !writingDuo else { return }
    writingDuo = true
    var body = Data([6, UInt8(metadata.count >> 8), UInt8(metadata.count & 0xff)])
    body += metadata
    body += frame.jpeg
    writer.async {
      write(body)
      lock.lock()
      writingDuo = false
      lock.unlock()
    }
  }

  static func video(_ unit: AccessUnit) {
    lock.lock()
    defer { lock.unlock() }
    if videoNeedsKeyframe && !unit.keyframe { return }
    guard pendingVideo < maxPendingVideo else {
      videoNeedsKeyframe = true
      return
    }
    videoNeedsKeyframe = false
    keyframeRequested = false
    pendingVideo += 1
    let artwork = unit.artworkTurns.map { UInt8(32 | ($0 << 3)) } ?? 0
    var body = Data([3, (unit.keyframe ? 1 : 0) | artwork])
    withUnsafeBytes(of: unit.capturedAt.bitPattern.bigEndian) { body.append(contentsOf: $0) }
    body += Data([UInt8(unit.width >> 8), UInt8(unit.width & 0xff), UInt8(unit.height >> 8), UInt8(unit.height & 0xff)])
    body += unit.data
    writer.async {
      write(body)
      lock.lock()
      pendingVideo -= 1
      let ask = videoNeedsKeyframe && !keyframeRequested
      if ask { keyframeRequested = true }
      lock.unlock()
      if ask { requestKeyframe() }
    }
  }

  /// Recording units are never dropped: a gap would leave the rest of the segment undecodable.
  static func record(_ unit: AccessUnit) {
    var body = Data([4, unit.keyframe ? 1 : 0])
    withUnsafeBytes(of: unit.capturedAt.bitPattern.bigEndian) { body.append(contentsOf: $0) }
    body += Data([UInt8(unit.width >> 8), UInt8(unit.width & 0xff), UInt8(unit.height >> 8), UInt8(unit.height & 0xff)])
    body += unit.data
    writer.async { write(body) }
  }

  static func notice(_ object: [String: Any]) {
    guard let json = try? JSONSerialization.data(withJSONObject: object) else { return }
    writer.sync { write(Data([2]) + json) }
  }

  private static func write(_ body: Data) {
    let length = UInt32(body.count)
    var message = Data([UInt8(length >> 24), UInt8((length >> 16) & 0xff), UInt8((length >> 8) & 0xff), UInt8(length & 0xff)])
    message += body
    FileHandle.standardOutput.write(message)
  }
}

/// Runs before every exit, so a source can undo what it did on a device.
var beforeExit: () -> Void = {}

func fail(_ message: String) -> Never {
  Output.notice(["error": message])
  beforeExit()
  exit(1)
}

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let context = CIContext(options: [.cacheIntermediates: false])

func jpeg(_ image: CIImage, config: Config) -> (Data, Int, Int)? {
  let extent = image.extent
  let scale = min(1, Double(config.maxEdge) / max(extent.width, extent.height))
  let scaled = scale < 1 ? image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) : image
  let size = scaled.extent.integral
  let cropped = scaled.transformed(by: CGAffineTransform(translationX: -size.minX, y: -size.minY))
  guard size.width > 0, size.height > 0,
    let data = context.jpegRepresentation(
      of: cropped.cropped(to: CGRect(origin: .zero, size: size.size)), colorSpace: colorSpace,
      options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): config.quality])
  else { return nil }
  return (data, Int(size.width), Int(size.height))
}

final class Pacer {
  let queue = DispatchQueue(label: "stim.frames.pacer")
  var config = Config()
  private var dirty = false
  private var scheduled = false
  private var last = DispatchTime(uptimeNanoseconds: 0)
  private let render: (Config) -> Void

  init(render: @escaping (Config) -> Void) {
    self.render = render
  }

  func changed() {
    queue.async {
      self.dirty = true
      self.schedule()
    }
  }

  private func schedule() {
    guard dirty, !scheduled, config.fps > 0 else { return }
    let next = last + .nanoseconds(Int(1_000_000_000 / max(config.fps, 0.1)))
    scheduled = true
    queue.asyncAfter(deadline: max(next, .now())) {
      self.scheduled = false
      guard self.dirty else { return }
      self.dirty = false
      self.last = .now()
      self.render(self.config)
    }
  }
}

func videoEncoder() -> VideoEncoder {
  VideoEncoder(maxEdge: Config().maxEdge, fps: Int(Config().fps), bitrate: Config().bitrate, output: Output.video)
}

func recordEncoder() -> VideoEncoder {
  VideoEncoder(maxEdge: Config().maxEdge, fps: Int(Config().fps), bitrate: Config().bitrate, output: Output.record)
}

extension VideoEncoder {
  func configure(record config: Config) {
    configure(
      enabled: config.record != nil, maxEdge: config.record?.maxEdge ?? config.maxEdge,
      fps: Int(config.record?.fps ?? config.fps), bitrate: config.record?.bitrate ?? config.bitrate)
  }
}

/// Keeps the recording encoder at its own fps while live video renders faster, the way JpegGate paces JPEG.
final class RecordGate {
  private let gate = JpegGate()

  func admit(_ config: Config, pacer: Pacer) -> Bool {
    guard let record = config.record else { return false }
    var paced = config
    paced.jpegFps = record.fps
    return gate.admit(paced, pacer: pacer)
  }
}

/// Keeps JPEG at `jpegFps` while video renders faster. A frame it skips is rendered again once the
/// interval passes, so the last frame of a burst still reaches JPEG subscribers. Used on the pacer queue.
final class JpegGate {
  private var last = 0.0
  private var retrying = false

  func admit(_ config: Config, pacer: Pacer) -> Bool {
    let now = CFAbsoluteTimeGetCurrent()
    let wait = last + 1 / max(config.jpegFps ?? config.fps, 0.1) - now
    if wait <= 0 {
      last = now
      return true
    }
    if !retrying {
      retrying = true
      pacer.queue.asyncAfter(deadline: .now() + wait) {
        self.retrying = false
        pacer.changed()
      }
    }
    return false
  }
}

func now() -> Double { Date().timeIntervalSince1970 * 1000 }

final class SimulatorSource {
  let udid: String
  let inputQueue = DispatchQueue(label: "stim.frames.input")
  var hid: SimulatorHID?
  private let pacer: Pacer
  private var displays: [SimDisplay] = []
  private var displayIndex = 0
  private var reportedDisplay: Int?
  private let callbackID = NSUUID()
  private let video = videoEncoder()
  private let recorder = recordEncoder()
  private let recordGate = RecordGate()
  private let jpegGate = JpegGate()
  private let duoGate = JpegGate()
  private var duo: DuoCaptureSource?
  private var duoRendering = false
  private var duoMissed = false
  private let stopLock = NSLock()
  private var frameTurns: Int?
  private lazy var artwork = FrameArtworkPublisher { SimulatorFrameArtwork.load(udid: self.udid) }

  init(udid: String) {
    self.udid = udid
    var render: (Config) -> Void = { _ in }
    pacer = Pacer { render($0) }
    render = { [unowned self] config in self.render(config) }
  }

  var queue: DispatchQueue { pacer.queue }

  func stop() {
    stopLock.lock()
    defer { stopLock.unlock() }
    let touch = DispatchQueue.main.sync { MainActor.assumeIsolated { duo?.configure(nil) } }
    guard let touch else { return }
    inputQueue.sync { hid?.touch(.up, at: touch.point, screenID: touch.screenID) }
  }

  func start(deadline: Date = Date().addingTimeInterval(30)) {
    let found = CoreSimulator.displays(udid: udid)
    guard !found.isEmpty else {
      if Date() > deadline { fail("Simulator \(udid) has no display with a framebuffer. Is it booted?") }
      queue.asyncAfter(deadline: .now() + 1) { self.start(deadline: deadline) }
      return
    }
    displays = found
    displayIndex = 0
    for display in found {
      display.registerDamageCallback(callbackID) { [weak self] _ in self?.pacer.changed() }
      display.registerSurfacesCallback(callbackID) { [weak self] _ in self?.pacer.changed() }
      display.registerPropertiesCallback(callbackID) { [weak self] _ in self?.pacer.changed() }
    }
    pacer.changed()
    watch()
  }

  // A simulator that shuts down and boots again gets new display objects, and
  // the old ones stop reporting damage; so does its HID client. CoreSimulator
  // returns a new proxy for the same display on every lookup, so the watch
  // follows the device state instead, where 3 is SimDeviceStateBooted.
  private func watch() {
    queue.asyncAfter(deadline: .now() + 2) {
      guard CoreSimulator.device(udid: self.udid)?.value(forKey: "state") as? Int != 3 else {
        if self.displays.count > 1 { self.pacer.changed() }
        return self.watch()
      }
      for display in self.displays {
        display.unregisterDamageCallback(self.callbackID)
        display.unregisterSurfacesCallback(self.callbackID)
        display.unregisterPropertiesCallback(self.callbackID)
      }
      self.displays = []
      self.reportedDisplay = nil
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.releaseDuo(self.duo?.configure(nil))
          self.duo = nil
        }
      }
      self.inputQueue.async { self.hid = nil }
      self.start()
    }
  }

  // CoreSimulator keeps the built-in display an iPhone Duo's posture turned
  // off, the cover or the inner one, all black, and sends no damage when it
  // turns off, so watch() also re-renders a device with several displays.
  private func litDisplay() -> SimDisplay? {
    let panels = displays.indices.filter { displays[$0].screenProperties?.screenType == 0 }
    guard panels.count > 1 else { return displays.first }
    let lit = { (index: Int) in self.displays[index].framebufferSurface.map { !isBlack($0) } ?? false }
    guard let index = lit(displayIndex) ? displayIndex : panels.first(where: lit) else {
      return displays[displayIndex]
    }
    displayIndex = index
    if reportedDisplay != index {
      reportedDisplay = index
      Output.notice(["display": index])
    }
    return displays[index]
  }

  func configure(_ config: Config) {
    video.configure(enabled: config.video, maxEdge: config.maxEdge, fps: Int(config.fps), bitrate: config.bitrate)
    recorder.configure(record: config)
    queue.async {
      self.pacer.config = config
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          if self.duo == nil, config.duoFrame != nil {
            self.duo = DuoCaptureSource(udid: self.udid, changed: self.pacer.changed)
          }
          self.releaseDuo(self.duo?.configure(config.duoFrame))
        }
      }
      self.pacer.changed()
    }
  }

  func keyframe() {
    video.requestKeyframe()
    pacer.changed()
  }

  func recordKeyframe() {
    recorder.requestKeyframe()
    pacer.changed()
  }

  // uiOrientation is a UIInterfaceOrientation; the framebuffer stays in the
  // display's native portrait orientation, so the image is turned upright.
  private func render(_ config: Config) {
    guard let display = litDisplay(), let surface = display.framebufferSurface else { return }
    let orientation: CGImagePropertyOrientation
    let quarterTurns: Int
    switch display.screenProperties?.uiOrientation ?? 1 {
    case 2: (orientation, quarterTurns) = (.down, 2)
    case 3: (orientation, quarterTurns) = (.right, 3)
    case 4: (orientation, quarterTurns) = (.left, 1)
    default: (orientation, quarterTurns) = (.up, 0)
    }
    let ioSurface = unsafeBitCast(surface, to: IOSurfaceRef.self)
    let artworkTurns = (4 - quarterTurns) % 4
    if config.duoFrame != nil, duoRendering { duoMissed = true }
    if let requested = config.duoFrame, !duoRendering,
      let properties = display.screenProperties
    {
      var paced = config
      paced.jpegFps = requested.fps
      if duoGate.admit(paced, pacer: pacer) {
        duoRendering = true
        let surfaces = displays.compactMap { display -> (screenID: UInt32, surface: IOSurface?)? in
          guard let properties = display.screenProperties, properties.screenType == 0 else { return nil }
          return (properties.screenID, display.framebufferSurface)
        }
        let viewport = CIImage(ioSurface: ioSurface).oriented(orientation).extent.size
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            if self.duo == nil {
              self.duo = DuoCaptureSource(udid: self.udid, changed: self.pacer.changed)
              self.releaseDuo(self.duo?.configure(config.duoFrame))
            }
            self.duo?.render(
              surfaces: surfaces, activeID: properties.screenID,
              orientation: properties.uiOrientation, viewport: viewport, config: config)
            self.queue.async {
              self.duoRendering = false
              if self.duoMissed {
                self.duoMissed = false
                self.pacer.changed()
              }
            }
          }
        }
      }
    }
    if config.deviceFrame, frameTurns != artworkTurns {
      frameTurns = artworkTurns
      artwork.send(quarterTurns: artworkTurns)
    }
    let record = recordGate.admit(config, pacer: pacer)
    if config.video || record {
      var buffer: Unmanaged<CVPixelBuffer>?
      CVPixelBufferCreateWithIOSurface(nil, ioSurface, nil, &buffer)
      if let pixels = buffer?.takeRetainedValue() {
        let capturedAt = now()
        if config.video { video.encode(pixels, quarterTurns: quarterTurns, capturedAt: capturedAt, artworkTurns: artworkTurns) }
        if record { recorder.encode(pixels, quarterTurns: quarterTurns, capturedAt: capturedAt) }
      }
    }
    guard config.jpeg, jpegGate.admit(config, pacer: pacer) else { return }
    let image = CIImage(ioSurface: ioSurface).oriented(orientation)
    guard let (data, width, height) = jpeg(image, config: config) else { return }
    Output.frame(jpeg: data, width: width, height: height, artworkTurns: artworkTurns)
  }
}

final class EmulatorSource {
  let serial: String
  let avdName: String?
  let queue = DispatchQueue(label: "stim.frames.emulator")
  let inputQueue = DispatchQueue(label: "stim.frames.emulator-input")
  var input: EmulatorInput?
  private var status: (size: CGSize?, keyboard: Bool)?
  private var stream: ScreenshotStream?
  private var generation = 0
  private var config = Config()
  var latest: EmulatorFrame?
  private var pacer: Pacer!
  private let video = videoEncoder()
  private let recorder = recordEncoder()
  private let recordGate = RecordGate()
  private let jpegGate = JpegGate()
  private var frameTurns: Int?
  private lazy var artwork = FrameArtworkPublisher { self.avdName.flatMap { EmulatorFrameArtwork.load(avdName: $0) } }

  init(serial: String, avdName: String? = nil) {
    self.serial = serial
    self.avdName = avdName
    pacer = Pacer { [unowned self] config in
      guard let frame = self.queue.sync(execute: { self.latest }) else { return }
      self.render(frame, config: config)
    }
  }

  func start() {
    queue.async { self.connect() }
    inputQueue.async {
      if let status = self.inputClient().flatMap(self.readStatus) {
        Output.notice(["keyboard": status.keyboard ? "yes" : "no"])
      }
    }
  }

  func configure(_ config: Config) {
    video.configure(enabled: config.video, maxEdge: config.maxEdge, fps: Int(config.fps), bitrate: config.bitrate)
    recorder.configure(record: config)
    queue.async {
      let resized = config.maxEdge != self.config.maxEdge
      self.config = config
      self.pacer.queue.async {
        self.pacer.config = config
        self.pacer.changed()
      }
      if resized, let stream = self.stream {
        self.stream = nil
        stream.cancel()
        self.connect()
      }
    }
  }

  func keyframe() {
    video.requestKeyframe()
    pacer.changed()
  }

  func recordKeyframe() {
    recorder.requestKeyframe()
    pacer.changed()
  }

  private func connect() {
    guard let endpoint = EmulatorDiscovery.endpoint(serial: serial) else {
      fail("\(serial) has no gRPC endpoint. Frames appear after Stim next boots this emulator.")
    }
    generation += 1
    let current = generation
    let stream = ScreenshotStream(
      endpoint: endpoint, width: config.maxEdge, height: config.maxEdge,
      onFrame: { [weak self] frame in
        guard let self else { return }
        self.queue.async { self.latest = frame }
        self.pacer.changed()
      },
      onEnd: { [weak self] in
        guard let self else { return }
        self.queue.async {
          if self.generation == current { fail("The emulator \(self.serial) ended its screenshot stream.") }
        }
      })
    self.stream = stream
    stream.start()
  }

  private func render(_ frame: EmulatorFrame, config: Config) {
    let capturedAt = now()
    let artworkTurns = (-frame.rotation % 4 + 4) % 4
    if config.deviceFrame, frameTurns != artworkTurns {
      frameTurns = artworkTurns
      artwork.send(quarterTurns: artworkTurns)
    }
    if config.video {
      video.encode(rgba: frame.rgba, width: frame.width, height: frame.height, capturedAt: capturedAt, artworkTurns: artworkTurns)
    }
    if recordGate.admit(config, pacer: pacer) {
      recorder.encode(rgba: frame.rgba, width: frame.width, height: frame.height, capturedAt: capturedAt)
    }
    guard config.jpeg, jpegGate.admit(config, pacer: pacer), let provider = CGDataProvider(data: frame.rgba as CFData),
      let image = CGImage(
        width: frame.width, height: frame.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: frame.width * 4,
        space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
      let (data, width, height) = jpeg(CIImage(cgImage: image), config: config)
    else { return }
    Output.frame(jpeg: data, width: width, height: height, artworkTurns: artworkTurns)
  }
}

final class AndroidDeviceSource {
  let queue = DispatchQueue(label: "stim.frames.android-device")
  let stream: AndroidDeviceStream
  private var latest: CVPixelBuffer?
  private var pacer: Pacer!
  private let video = videoEncoder()
  private let jpegGate = JpegGate()

  init(serial: String, adb: String, serverJar: URL) {
    stream = AndroidDeviceStream(serial: serial, adb: adb, serverJar: serverJar)
    pacer = Pacer { [unowned self] config in
      guard let frame = self.queue.sync(execute: { self.latest }) else { return }
      self.render(frame, config: config)
    }
  }

  func start() {
    stream.onFrame = { [weak self] frame in
      guard let self else { return }
      self.queue.async { self.latest = frame }
      self.pacer.changed()
    }
    stream.onEnd = { fail($0) }
    stream.start()
  }

  func configure(_ config: Config) {
    video.configure(enabled: config.video, maxEdge: config.maxEdge, fps: Int(config.fps), bitrate: config.bitrate)
    pacer.queue.async {
      self.pacer.config = config
      self.pacer.changed()
    }
  }

  /// A device whose screen does not change sends no frame, so a keyframe re-encodes the last one.
  func keyframe() {
    video.requestKeyframe()
    pacer.changed()
  }

  /// stim-server does not record a physical device.
  func recordKeyframe() {}

  private func render(_ frame: CVPixelBuffer, config: Config) {
    if config.video { video.encode(frame, quarterTurns: 0, capturedAt: now()) }
    guard config.jpeg, jpegGate.admit(config, pacer: pacer),
      let (data, width, height) = jpeg(CIImage(cvPixelBuffer: frame), config: config)
    else { return }
    Output.frame(jpeg: data, width: width, height: height)
  }
}

extension AndroidDeviceSource: Source {
  func input(_ command: Command) {
    switch command {
    case .touch(let phase, let point, let display):
      guard display == 0 else { return Output.notice(["inputError": "Input goes to the device's main display only."]) }
      guard let size = stream.size else { return Output.notice(["inputError": "The device has sent no frame yet."]) }
      let action: Scrcpy.TouchAction = phase == .down ? .down : phase == .up ? .up : .move
      stream.send(
        Scrcpy.touch(
          action, x: Int32((point.x * Double(size.width - 1)).rounded()),
          y: Int32((point.y * Double(size.height - 1)).rounded()), width: UInt16(size.width),
          height: UInt16(size.height)))
    case .text(let text):
      var run = ""
      let flush = {
        if !run.isEmpty { self.stream.send(Scrcpy.text(run)) }
        run = ""
      }
      for character in text {
        if let key = Scrcpy.keycodes[String(character)] {
          flush()
          stream.send(Scrcpy.keycode(.down, key))
          stream.send(Scrcpy.keycode(.up, key))
        } else {
          run.append(character)
        }
      }
      flush()
    case .button(let name):
      guard ["home", "back", "app-switch", "lock"].contains(name), let key = Scrcpy.keycodes[name] else {
        return Output.notice(["inputError": "Android has no \(name) button."])
      }
      stream.send(Scrcpy.keycode(.down, key))
      stream.send(Scrcpy.keycode(.up, key))
    case .rotate, .posture:
      Output.notice(["inputError": "A physical device rotates and folds only in hand."])
    case .config, .keyframe, .recordKeyframe, .control, .scoped, .scroll, .key, .window, .duoTouch, .duoRelease:
      break
    }
  }
}

final class WebSource {
  let queue = DispatchQueue(label: "stim.frames.web")
  private let endpoint: URL
  private let chromePid: Int32
  private let targetId: String
  private var page: WebPage?
  private var latest: ScreencastFrame?
  private var screencast: (maxEdge: Int, quality: Int)?
  private var config = Config()
  private var pacer: Pacer!
  private let video = videoEncoder()
  private let recorder = recordEncoder()
  private let recordGate = RecordGate()
  private let jpegGate = JpegGate()
  private var pixels: CVPixelBufferPool?
  private var pixelSize = (width: 0, height: 0)
  private var encodedAt: Double?
  private var waiting: [Command] = []

  init(endpoint: URL, chromePid: Int32, targetId: String) {
    self.endpoint = endpoint
    self.chromePid = chromePid
    self.targetId = targetId
    pacer = Pacer { [unowned self] config in
      guard let frame = self.queue.sync(execute: { self.latest }) else { return }
      self.render(frame, config: config)
    }
  }

  func start() {
    WebPage.open(endpoint: endpoint, chromePid: chromePid, targetId: targetId) { result in
      switch result {
      case .failure(let failure):
        fail(failure.description)
      case .success(let page):
        page.onEnd { fail($0) }
        page.onFrame { frame in
          self.queue.async { self.latest = frame }
          self.pacer.changed()
        }
        self.queue.async {
          self.page = page
          self.updateScreencast()
          let waiting = self.waiting
          self.waiting = []
          for command in waiting { self.apply(command, on: page) }
        }
      }
    }
  }

  func configure(_ config: Config) {
    video.configure(enabled: config.video, maxEdge: config.maxEdge, fps: Int(config.fps), bitrate: config.bitrate)
    recorder.configure(record: config)
    queue.async {
      self.config = config
      self.updateScreencast()
      self.pacer.queue.async {
        self.pacer.config = config
        self.pacer.changed()
      }
    }
  }

  /// A page that does not change sends no frame, so a keyframe re-encodes the last one.
  func keyframe() {
    video.requestKeyframe()
    pacer.changed()
  }

  func recordKeyframe() {
    recorder.requestKeyframe()
    pacer.changed()
  }

  private func updateScreencast() {
    guard let page else { return }
    guard config.fps > 0 else {
      if screencast != nil { page.stopScreencast() }
      screencast = nil
      return
    }
    let wanted = (maxEdge: config.maxEdge, quality: config.video ? 85 : Int(config.quality * 100))
    guard screencast.map({ $0 != wanted }) ?? true else { return }
    screencast = wanted
    page.startScreencast(maxEdge: wanted.maxEdge, quality: wanted.quality)
  }

  private func render(_ frame: ScreencastFrame, config: Config) {
    guard let source = CGImageSourceCreateWithData(frame.jpeg as CFData, nil) else { return }
    let record = recordGate.admit(config, pacer: pacer)
    if config.video || record, let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let buffer = pixelBuffer(image)
    {
      let repeated = frame.capturedAt == encodedAt
      encodedAt = frame.capturedAt
      let capturedAt = repeated ? now() : frame.capturedAt
      if config.video { video.encode(buffer, quarterTurns: 0, capturedAt: capturedAt) }
      if record { recorder.encode(buffer, quarterTurns: 0, capturedAt: capturedAt) }
    }
    guard config.jpeg, jpegGate.admit(config, pacer: pacer),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int
    else { return }
    Output.frame(jpeg: frame.jpeg, width: width, height: height)
  }

  private func pixelBuffer(_ image: CGImage) -> CVPixelBuffer? {
    let size = (width: image.width, height: image.height)
    if pixels == nil || pixelSize != size {
      let attributes: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey: size.width,
        kCVPixelBufferHeightKey: size.height,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
      ]
      pixels = nil
      CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pixels)
      pixelSize = size
    }
    var buffer: CVPixelBuffer?
    guard let pixels, CVPixelBufferPoolCreatePixelBuffer(nil, pixels, &buffer) == kCVReturnSuccess, let buffer else {
      return nil
    }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard
      let context = CGContext(
        data: CVPixelBufferGetBaseAddress(buffer), width: size.width, height: size.height, bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
    return buffer
  }
}

extension WebSource: Source {
  func input(_ command: Command) {
    queue.async {
      guard let page = self.page else { return self.waiting.append(command) }
      self.apply(command, on: page)
    }
  }

  private func apply(_ command: Command, on page: WebPage) {
    switch command {
    case .touch(let phase, let point, _):
      switch phase {
      case .down: page.touch(.down, x: point.x, y: point.y)
      case .move: page.touch(.move, x: point.x, y: point.y)
      case .up: page.touch(.up, x: point.x, y: point.y)
      }
    case .text(let text):
      page.type(text)
    case .button(let name):
      guard name == "back" else { return Output.notice(["inputError": "A web page has no \(name) button."]) }
      page.back()
    case .rotate, .posture:
      Output.notice(["inputError": "A web page does not rotate or fold."])
    case .config, .keyframe, .recordKeyframe, .control, .scoped, .scroll, .key, .window, .duoTouch, .duoRelease:
      break
    }
  }
}

indirect enum Command {
  case control(String, enabled: Bool)
  case scoped(String, Command)
  case scroll(CGPoint, delta: CGPoint)
  case key(String, modifiers: [String])
  case window(UInt32?)
  case config(Config)
  case keyframe
  case recordKeyframe
  case touch(TouchPhase, CGPoint, display: Int)
  case duoTouch(TouchPhase, CGPoint, revision: String)
  case duoRelease
  case text(String)
  case button(String)
  case rotate(clockwise: Bool)
  case posture(EmulatorPosture)
}

func parseCommand(_ line: String, base: Config) -> Command? {
  guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return nil }
  if let control = object["control"] as? [String: Any], let session = control["session"] as? String,
    let enabled = control["enabled"] as? Bool { return .control(session, enabled: enabled) }
  if let session = object["controlSession"] as? String {
    var unscoped = object
    unscoped.removeValue(forKey: "controlSession")
    guard let data = try? JSONSerialization.data(withJSONObject: unscoped),
      let command = parseCommand(String(decoding: data, as: UTF8.self), base: base)
    else { return nil }
    return .scoped(session, command)
  }
  if object["keyframe"] as? Bool == true { return .keyframe }
  if object["recordKeyframe"] as? Bool == true { return .recordKeyframe }
  switch object["input"] as? String {
  case "duo-release":
    return .duoRelease
  case "touch":
    let phases: [String: TouchPhase] = ["down": .down, "move": .move, "up": .up]
    guard let phase = (object["phase"] as? String).flatMap({ phases[$0] }),
      let x = object["x"] as? Double, let y = object["y"] as? Double, (0...1).contains(x), (0...1).contains(y)
    else { return nil }
    if let revision = object["duoRevision"] as? String, UUID(uuidString: revision) != nil {
      return .duoTouch(phase, CGPoint(x: x, y: y), revision: revision)
    }
    return .touch(phase, CGPoint(x: x, y: y), display: object["display"] as? Int ?? 0)
  case "scroll":
    guard let x = object["x"] as? Double, let y = object["y"] as? Double,
      let dx = object["deltaX"] as? Double, let dy = object["deltaY"] as? Double,
      (0...1).contains(x), (0...1).contains(y), dx.isFinite, dy.isFinite, abs(dx) <= 1000, abs(dy) <= 1000
    else { return nil }
    return .scroll(CGPoint(x: x, y: y), delta: CGPoint(x: dx, y: dy))
  case "key":
    guard let key = object["key"] as? String, let modifiers = object["modifiers"] as? [String] else { return nil }
    return .key(key, modifiers: modifiers)
  case "window":
    if object["window"] is NSNull { return .window(nil) }
    guard let id = object["window"] as? Int, let window = UInt32(exactly: id) else { return nil }
    return .window(window)
  case "text":
    return (object["text"] as? String).map { .text($0) }
  case "button":
    return (object["button"] as? String).map { .button($0) }
  case "rotate":
    let directions = ["left": false, "right": true]
    return (object["direction"] as? String).flatMap { directions[$0] }.map { .rotate(clockwise: $0) }
  case "posture":
    let postures: [String: EmulatorPosture] = ["folded": .closed, "half-open": .halfOpened, "unfolded": .opened]
    return (object["posture"] as? String).flatMap { postures[$0] }.map { .posture($0) }
  case nil:
    var config = base
    if let fps = object["fps"] as? Double, fps >= 0 { config.fps = min(fps, 60) }
    if let edge = object["maxEdge"] as? Int, edge > 0 { config.maxEdge = min(edge, 4096) }
    if let quality = object["quality"] as? Double, quality > 0, quality <= 1 { config.quality = quality }
    if let jpeg = object["jpeg"] as? Bool { config.jpeg = jpeg }
    if let jpegFps = object["jpegFps"] as? Double, jpegFps > 0 { config.jpegFps = min(jpegFps, 60) }
    if let video = object["video"] as? Bool { config.video = video }
    config.deviceFrame = object["deviceFrame"] as? Bool ?? false
    config.duoFrame = (object["duoFrame"] as? [String: Any]).flatMap { duo in
      guard let edge = duo["maxEdge"] as? Int, edge > 0,
        let fps = duo["fps"] as? Double, fps > 0
      else { return nil }
      return DuoCapture(maxEdge: min(edge, 4096), fps: min(fps, 60))
    }
    if let bitrate = object["bitrate"] as? Int, bitrate > 0 { config.bitrate = bitrate }
    config.record = (object["record"] as? [String: Any]).flatMap { record in
      guard let edge = record["maxEdge"] as? Int, edge > 0, let bitrate = record["bitrate"] as? Int, bitrate > 0,
        let fps = record["fps"] as? Double, fps > 0
      else { return nil }
      return Recording(maxEdge: min(edge, 4096), fps: min(fps, 60), bitrate: bitrate)
    }
    return .config(config)
  default:
    return nil
  }
}

protocol Source: AnyObject {
  func configure(_ config: Config)
  func keyframe()
  func recordKeyframe()
  func input(_ command: Command)
}

func readCommands(_ source: Source) {
  Thread.detachNewThread {
    var buffer = Data()
    var config = Config()
    while true {
      let chunk = FileHandle.standardInput.availableData
      if chunk.isEmpty {
        beforeExit()
        exit(0)
      }
      buffer += chunk
      while let newline = buffer.firstIndex(of: 0x0a) {
        let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
        buffer.removeSubrange(buffer.startIndex...newline)
        switch parseCommand(line, base: config) {
        case .config(let parsed)?:
          config = parsed
          source.configure(config)
        case .keyframe?:
          source.keyframe()
        case .recordKeyframe?:
          source.recordKeyframe()
        case let command?:
          source.input(command)
        case nil:
          Output.notice(["inputError": "stim-frames could not read \(line.prefix(80))"])
        }
      }
    }
  }
}

// macOS virtual key codes of a US keyboard, which SimulatorKit's
// hidUsageForCGKeyCode turns into HID usages and the emulator turns into evdev
// keys; shifted characters also hold Shift (0x38).
let keyCodes: [Character: (code: UInt16, shift: Bool)] = {
  var map: [Character: (UInt16, Bool)] = [:]
  let plain: [(String, UInt16)] = [
    ("a", 0x00), ("s", 0x01), ("d", 0x02), ("f", 0x03), ("h", 0x04), ("g", 0x05), ("z", 0x06), ("x", 0x07),
    ("c", 0x08), ("v", 0x09), ("b", 0x0B), ("q", 0x0C), ("w", 0x0D), ("e", 0x0E), ("r", 0x0F), ("y", 0x10),
    ("t", 0x11), ("1", 0x12), ("2", 0x13), ("3", 0x14), ("4", 0x15), ("6", 0x16), ("5", 0x17), ("=", 0x18),
    ("9", 0x19), ("7", 0x1A), ("-", 0x1B), ("8", 0x1C), ("0", 0x1D), ("]", 0x1E), ("o", 0x1F), ("u", 0x20),
    ("[", 0x21), ("i", 0x22), ("p", 0x23), ("l", 0x25), ("j", 0x26), ("'", 0x27), ("k", 0x28), (";", 0x29),
    ("\\", 0x2A), (",", 0x2B), ("/", 0x2C), ("n", 0x2D), ("m", 0x2E), (".", 0x2F), ("`", 0x32), (" ", 0x31),
    ("\n", 0x24), ("\t", 0x30), ("\u{8}", 0x33),
  ]
  for (text, code) in plain { map[Character(text)] = (code, false) }
  for letter in "abcdefghijklmnopqrstuvwxyz" { map[Character(letter.uppercased())] = (map[letter]!.0, true) }
  let shifted: [(Character, Character)] = [
    ("!", "1"), ("@", "2"), ("#", "3"), ("$", "4"), ("%", "5"), ("^", "6"), ("&", "7"), ("*", "8"), ("(", "9"),
    (")", "0"), ("_", "-"), ("+", "="), ("{", "["), ("}", "]"), ("|", "\\"), (":", ";"), ("\"", "'"), ("<", ","),
    (">", "."), ("?", "/"), ("~", "`"),
  ]
  for (character, base) in shifted { map[character] = (map[base]!.0, true) }
  return map
}()

extension SimulatorSource: Source {
  func input(_ command: Command) {
    if case .duoTouch(let phase, let point, let revision) = command {
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let touch = self.duo?.touch(phase, point: point, revision: revision) else { return }
          self.inputQueue.async {
            if self.hid?.isConnected != true { self.hid = SimulatorHID(udid: self.udid) }
            self.hid?.touch(phase, at: touch.point, screenID: touch.screenID)
          }
        }
      }
      return
    }
    if case .duoRelease = command {
      DispatchQueue.main.async { MainActor.assumeIsolated { self.releaseDuo(self.duo?.release()) } }
      return
    }
    inputQueue.async { self.apply(command) }
  }

  private func releaseDuo(_ touch: DuoFrameRenderer.Touch?) {
    guard let touch else { return }
    inputQueue.async { self.hid?.touch(.up, at: touch.point, screenID: touch.screenID) }
  }

  private func apply(_ command: Command) {
    if case .rotate(let clockwise) = command {
      if !SimulatorRotation.rotate(udid: udid, clockwise: clockwise) {
        Output.notice(["inputError": "\(udid) did not take the rotation."])
      }
      return
    }
    if hid?.isConnected != true { hid = SimulatorHID(udid: udid) }
    guard let hid else { return Output.notice(["inputError": "\(udid) could not be opened for input."]) }
    switch command {
    case .touch(let phase, let point, let index):
      let displays = CoreSimulator.displays(udid: udid)
      guard displays.indices.contains(index), let properties = displays[index].screenProperties else {
        return Output.notice(["inputError": "\(udid) has no display \(index)."])
      }
      hid.touch(phase, at: nativeScreenPoint(point, orientation: properties.uiOrientation), screenID: properties.screenID)
    case .text(let text):
      for character in text {
        guard let key = keyCodes[character] else { continue }
        if key.shift { hid.hardwareKey(code: 0x38, down: true) }
        hid.hardwareKey(code: key.code, down: true)
        usleep(10_000)
        hid.hardwareKey(code: key.code, down: false)
        if key.shift { hid.hardwareKey(code: 0x38, down: false) }
        usleep(15_000)
      }
    case .button(let name):
      let buttons: [String: SimulatorButton] = ["home": .home, "lock": .lock]
      guard let button = buttons[name] else { return Output.notice(["inputError": "iOS has no \(name) button."]) }
      hid.button(button, down: true)
      usleep(100_000)
      hid.button(button, down: false)
    case .config, .keyframe, .recordKeyframe, .rotate, .posture, .control, .scoped, .scroll, .key, .window, .duoTouch, .duoRelease:
      break
    }
  }
}

private final class Applied: @unchecked Sendable {
  var value = false
}

extension EmulatorSource: Source {
  func input(_ command: Command) {
    inputQueue.async { self.apply(command) }
  }

  private func apply(_ command: Command) {
    guard let input = inputClient() else { return Output.notice(["inputError": "\(serial) has no gRPC endpoint for input."]) }
    switch command {
    case .touch(let phase, let point, let index):
      guard index == 0 else { return Output.notice(["inputError": "Input goes to the emulator's main display only."]) }
      guard let size = readStatus(input)?.size else {
        return Output.notice(["inputError": "\(serial) did not report its display size."])
      }
      let rotation = queue.sync { latest?.rotation ?? 0 }
      let pixel = displayPixel(point, rotation: rotation, displaySize: size)
      input.call("sendTouch", InputMessages.touch(x: pixel.x, y: pixel.y, pressed: phase != .up))
    case .text(let text):
      guard readStatus(input)?.keyboard == true else { return noKeyboard() }
      for character in text {
        guard let key = keyCodes[character] else { continue }
        if key.shift { send(input, InputMessages.key(macKeyCode: 0x38, down: true)) }
        send(input, InputMessages.key(macKeyCode: key.code, down: true))
        send(input, InputMessages.key(macKeyCode: key.code, down: false))
        if key.shift { send(input, InputMessages.key(macKeyCode: 0x38, down: false)) }
        // The emulator reorders a shifted key and the next one when they arrive back to back.
        usleep(30_000)
      }
    case .button(let name):
      guard readStatus(input)?.keyboard == true else { return noKeyboard() }
      let keys = ["home": "GoHome", "back": "GoBack", "app-switch": "AppSwitch", "lock": "Power"]
      guard let key = keys[name] else { return Output.notice(["inputError": "Android has no \(name) button."]) }
      input.call("sendKey", InputMessages.namedKey(key))
    case .rotate(let clockwise):
      wait("rotation") { await EmulatorRotation.rotate(serial: self.serial, clockwise: clockwise) }
    case .posture(let posture):
      wait("posture") { await posture.apply(serial: self.serial) }
    case .config, .keyframe, .recordKeyframe, .control, .scoped, .scroll, .key, .window, .duoTouch, .duoRelease:
      break
    }
  }

  private func wait(_ change: String, _ operation: @escaping () async -> Bool) {
    let done = DispatchSemaphore(value: 0)
    let applied = Applied()
    Task {
      applied.value = await operation()
      done.signal()
    }
    if done.wait(timeout: .now() + 10) == .timedOut || !applied.value {
      Output.notice(["inputError": "\(serial) did not take the \(change) change."])
    }
  }

  private func send(_ input: EmulatorInput, _ key: Data) {
    let done = DispatchSemaphore(value: 0)
    input.call("sendKey", key) { _ in done.signal() }
    _ = done.wait(timeout: .now() + 5)
  }

  private func noKeyboard() {
    Output.notice(["inputError": "\(serial) has no hardware keyboard (hw.keyboard=no), so it drops key events."])
  }

  private func inputClient() -> EmulatorInput? {
    if input == nil, let endpoint = EmulatorDiscovery.endpoint(serial: serial) { input = EmulatorInput(endpoint: endpoint) }
    return input
  }

  private func readStatus(_ input: EmulatorInput) -> (size: CGSize?, keyboard: Bool)? {
    if let status { return status }
    let done = DispatchSemaphore(value: 0)
    var response: Data?
    input.call("getStatus", Data()) { reply in
      response = reply
      done.signal()
    }
    _ = done.wait(timeout: .now() + 5)
    guard let response else { return nil }
    let size = InputMessages.displaySize(fromStatus: response).map { CGSize(width: $0.width, height: $0.height) }
    status = (size, InputMessages.hasKeyboard(fromStatus: response))
    return status
  }
}

setvbuf(stdout, nil, _IONBF, 0)
signal(SIGPIPE, SIG_IGN)
let arguments = CommandLine.arguments
let usage =
  "usage: stim-frames ios <udid> | android <serial> | android-device <serial> <adb> <scrcpy-server> | web <cdpEndpoint> <chromePid> <targetId> | iphone <udid> [name]"
let terminated = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
let counts = [
  "simulator-options": [4, 5], "hinge-monitor": [3], "web": [5], "iphone": [3, 4], "android-device": [5], "android": [3, 4],
]
guard arguments.count > 1, (counts[arguments[1]] ?? [3]).contains(arguments.count) else { fail(usage) }
switch arguments[1] {
case "hinge-monitor":
  guard let directory = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] else { exit(1) }
  CoreSimulator.developerDir = directory
  DuoHingeMonitor.run(udid: arguments[2])
case "simulator-options":
  DispatchQueue.global().async {
    _ = FileHandle.standardInput.readDataToEndOfFile()
    exit(0)
  }
  CoreSimulator.developerDir = CoreSimulator.selectedDeveloperDir()
  do {
    let udid = arguments[2]
    let settings: SimulatorDevelopmentOptions.Settings
    switch arguments[3] {
    case "read" where arguments.count == 4:
      settings = try SimulatorDevelopmentOptions.read(udid: udid)
    case "shake" where arguments.count == 4:
      try SimulatorDevelopmentOptions.shake(udid: udid)
      settings = try SimulatorDevelopmentOptions.read(udid: udid)
    case "slow-animations" where arguments.count == 5 && ["on", "off"].contains(arguments[4]):
      settings = try SimulatorDevelopmentOptions.setSlowAnimations(arguments[4] == "on", udid: udid)
    default:
      throw NSError(domain: "StimFrames", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid simulator option."])
    }
    let result: [String: Any] = [
      "canShake": settings.canShake,
      "slowAnimations": settings.slowAnimations.map { $0 as Any } ?? NSNull(),
    ]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    exit(0)
  } catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
  }
case "macos":
  guard let data = arguments[2].data(using: .utf8),
    let app = try? JSONDecoder().decode(MacosSource.OwnedApp.self, from: data)
  else { fail("Invalid owned macOS app target.") }
  let source = MacosSource(app: app)
  let stop = source.stop
  beforeExit = stop
  signal(SIGTERM, SIG_IGN)
  terminated.setEventHandler {
    stop()
    exit(0)
  }
  terminated.resume()
  Output.requestKeyframe = source.keyframe
  readCommands(source)
  source.start()
case "ios":
  CoreSimulator.developerDir = CoreSimulator.selectedDeveloperDir()
  guard CoreSimulator.deviceSet != nil else { fail("CoreSimulator could not be loaded from \(CoreSimulator.developerDir).") }
  let source = SimulatorSource(udid: arguments[2])
  beforeExit = source.stop
  signal(SIGTERM, SIG_IGN)
  terminated.setEventHandler {
    source.stop()
    exit(0)
  }
  terminated.resume()
  Output.requestKeyframe = source.keyframe
  readCommands(source)
  source.queue.async { source.start() }
case "android":
  let source = EmulatorSource(serial: arguments[2], avdName: arguments.count == 4 ? arguments[3] : nil)
  Output.requestKeyframe = source.keyframe
  readCommands(source)
  source.start()
case "android-device":
  let source = AndroidDeviceSource(
    serial: arguments[2], adb: arguments[3], serverJar: URL(fileURLWithPath: arguments[4]))
  let stop = source.stream.stop
  beforeExit = stop
  signal(SIGTERM, SIG_IGN)
  terminated.setEventHandler {
    stop()
    exit(0)
  }
  terminated.resume()
  Output.requestKeyframe = source.keyframe
  readCommands(source)
  source.start()
case "web":
  guard let endpoint = URL(string: arguments[2]), let pid = Int32(arguments[3]) else { fail(usage) }
  let source = WebSource(endpoint: endpoint, chromePid: pid, targetId: arguments[4])
  Output.requestKeyframe = source.keyframe
  readCommands(source)
  source.start()
case "iphone":
  let source = PhoneSource(udid: arguments[2], name: arguments.count > 3 ? arguments[3] : nil)
  Output.requestKeyframe = source.keyframe
  readCommands(source)
  source.queue.async { source.start() }
default:
  fail(usage)
}
if arguments[1] == "macos" {
  // AppKit refreshes NSRunningApplication activation during main run-loop turns.
  RunLoop.main.add(Port(), forMode: .default)
  CFRunLoopRun()
} else {
  dispatchMain()
}
