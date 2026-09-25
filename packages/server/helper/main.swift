import CoreImage
import Foundation
import ImageIO
import IOSurface

// stim-frames streams one device's screen as JPEG frames for stim-server.
//
//   stim-frames ios <udid>
//   stim-frames android <serial>
//
// stdin takes one JSON object per line: {"fps": n, "maxEdge": px, "quality": 0-1}.
// stdout carries messages framed as a 4-byte big-endian length, then a kind byte:
// 1 is a frame (2-byte width, 2-byte height, JPEG bytes), 2 is a JSON notice
// ({"error": message} before a failed exit). The helper exits when stdin closes.

struct Config: Equatable {
  var fps = 5.0
  var maxEdge = 1280
  var quality = 0.7
}

enum Output {
  private static let writer = DispatchQueue(label: "stim.frames.output")
  private static let lock = NSLock()
  private static var writing = false

  static func frame(jpeg: Data, width: Int, height: Int) {
    lock.lock()
    defer { lock.unlock() }
    guard !writing else { return }
    writing = true
    var body = Data([1, UInt8(width >> 8), UInt8(width & 0xff), UInt8(height >> 8), UInt8(height & 0xff)])
    body += jpeg
    writer.async {
      write(body)
      lock.lock()
      writing = false
      lock.unlock()
    }
  }

  static func notice(_ object: [String: String]) {
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

func fail(_ message: String) -> Never {
  Output.notice(["error": message])
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
    guard dirty, !scheduled else { return }
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

final class SimulatorSource {
  private let udid: String
  private let pacer: Pacer
  private var display: SimDisplay?
  private let callbackID = NSUUID()

  init(udid: String) {
    self.udid = udid
    var render: (Config) -> Void = { _ in }
    pacer = Pacer { render($0) }
    render = { [unowned self] config in self.render(config) }
  }

  var queue: DispatchQueue { pacer.queue }

  func start(deadline: Date = Date().addingTimeInterval(30)) {
    guard let display = CoreSimulator.displays(udid: udid).first else {
      if Date() > deadline { fail("Simulator \(udid) has no display with a framebuffer. Is it booted?") }
      queue.asyncAfter(deadline: .now() + 1) { self.start(deadline: deadline) }
      return
    }
    self.display = display
    display.registerDamageCallback(callbackID) { [weak self] _ in self?.pacer.changed() }
    display.registerSurfacesCallback(callbackID) { [weak self] _ in self?.pacer.changed() }
    display.registerPropertiesCallback(callbackID) { [weak self] _ in self?.pacer.changed() }
    pacer.changed()
  }

  func configure(_ config: Config) {
    queue.async {
      self.pacer.config = config
      self.pacer.changed()
    }
  }

  // uiOrientation is a UIInterfaceOrientation; the framebuffer stays in the
  // display's native portrait orientation, so the image is turned upright.
  private func render(_ config: Config) {
    guard let surface = display?.framebufferSurface else { return }
    let orientation: CGImagePropertyOrientation
    switch display?.screenProperties?.uiOrientation ?? 1 {
    case 2: orientation = .down
    case 3: orientation = .right
    case 4: orientation = .left
    default: orientation = .up
    }
    let image = CIImage(ioSurface: unsafeBitCast(surface, to: IOSurfaceRef.self)).oriented(orientation)
    guard let (data, width, height) = jpeg(image, config: config) else { return }
    Output.frame(jpeg: data, width: width, height: height)
  }
}

final class EmulatorSource {
  private let serial: String
  private let queue = DispatchQueue(label: "stim.frames.emulator")
  private var stream: ScreenshotStream?
  private var generation = 0
  private var config = Config()
  private var latest: EmulatorFrame?
  private var pacer: Pacer!

  init(serial: String) {
    self.serial = serial
    pacer = Pacer { [unowned self] config in
      guard let frame = self.queue.sync(execute: { self.latest }) else { return }
      self.render(frame, config: config)
    }
  }

  func start() {
    queue.async { self.connect() }
  }

  func configure(_ config: Config) {
    queue.async {
      let resized = config.maxEdge != self.config.maxEdge
      self.config = config
      self.pacer.queue.async { self.pacer.config = config }
      if resized, let stream = self.stream {
        self.stream = nil
        stream.cancel()
        self.connect()
      }
    }
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
    guard let provider = CGDataProvider(data: frame.rgba as CFData),
      let image = CGImage(
        width: frame.width, height: frame.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: frame.width * 4,
        space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
      let (data, width, height) = jpeg(CIImage(cgImage: image), config: config)
    else { return }
    Output.frame(jpeg: data, width: width, height: height)
  }
}

func parseConfig(_ line: Substring, base: Config) -> Config? {
  guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return nil }
  var config = base
  if let fps = object["fps"] as? Double, fps > 0 { config.fps = min(fps, 60) }
  if let edge = object["maxEdge"] as? Int, edge > 0 { config.maxEdge = min(edge, 4096) }
  if let quality = object["quality"] as? Double, quality > 0, quality <= 1 { config.quality = quality }
  return config
}

func readCommands(_ apply: @escaping (Config) -> Void) {
  Thread.detachNewThread {
    var buffer = Data()
    var config = Config()
    while true {
      let chunk = FileHandle.standardInput.availableData
      if chunk.isEmpty { exit(0) }
      buffer += chunk
      while let newline = buffer.firstIndex(of: 0x0a) {
        let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
        buffer.removeSubrange(buffer.startIndex...newline)
        if let parsed = parseConfig(Substring(line), base: config) {
          config = parsed
          apply(config)
        }
      }
    }
  }
}

setvbuf(stdout, nil, _IONBF, 0)
signal(SIGPIPE, SIG_IGN)
let arguments = CommandLine.arguments
guard arguments.count == 3 else { fail("usage: stim-frames ios <udid> | android <serial>") }
switch arguments[1] {
case "ios":
  CoreSimulator.developerDir = CoreSimulator.selectedDeveloperDir()
  guard CoreSimulator.deviceSet != nil else { fail("CoreSimulator could not be loaded from \(CoreSimulator.developerDir).") }
  let source = SimulatorSource(udid: arguments[2])
  readCommands { source.configure($0) }
  source.queue.async { source.start() }
case "android":
  let source = EmulatorSource(serial: arguments[2])
  readCommands { source.configure($0) }
  source.start()
default:
  fail("usage: stim-frames ios <udid> | android <serial>")
}
dispatchMain()
