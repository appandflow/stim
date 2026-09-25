import CoreImage
import CoreVideo
import Foundation
import ImageIO
import IOSurface

// stim-frames streams one device's screen as JPEG frames for stim-server.
//
//   stim-frames ios <udid>
//   stim-frames android <serial>
//
// stdin takes one JSON object per line: {"fps": n, "maxEdge": px, "quality": 0-1,
// "jpeg": bool, "jpegFps": n, "video": bool, "bitrate": bits per second}, where fps 0
// pauses frames; {"keyframe": true} to make the next video frame a keyframe; or an input:
// {"input": "touch", "phase": "down|move|up", "x": 0-1, "y": 0-1, "display": n} with x
// and y on the upright screen; {"input": "text", "text": s}, printable ASCII where "\n"
// is Return, "\t" is Tab and "\u{8}" is Delete; and {"input": "button", "button":
// "home|lock"}, or on an emulator also "back|app-switch". An emulator types and presses
// buttons only with a hardware keyboard.
// stdout carries messages framed as a 4-byte big-endian length, then a kind byte:
// 1 is a frame (2-byte width, 2-byte height, JPEG bytes), 2 is a JSON notice
// ({"error": message} before a failed exit, {"inputError": message}, or on an emulator
// {"keyboard": "yes|no"} once it reports its hardware), 3 is an H.264 access unit (1-byte
// flags with bit 0 set on a keyframe, 8-byte big-endian float capture time in
// milliseconds since the epoch, 2-byte width, 2-byte height, Annex-B bytes).
// The helper exits when stdin closes.

struct Config: Equatable {
  var fps = 5.0
  var maxEdge = 1280
  var quality = 0.7
  var jpeg = true
  var jpegFps: Double?
  var video = false
  var bitrate = 3_000_000
}

enum Output {
  private static let writer = DispatchQueue(label: "stim.frames.output")
  private static let lock = NSLock()
  private static var writing = false
  private static var pendingVideo = 0
  private static var videoNeedsKeyframe = false
  private static var keyframeRequested = false
  private static let maxPendingVideo = 30
  static var requestKeyframe: () -> Void = {}

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
    var body = Data([3, unit.keyframe ? 1 : 0])
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
  private var display: SimDisplay?
  private let callbackID = NSUUID()
  private let video = videoEncoder()
  private let jpegGate = JpegGate()

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
    watch(display)
  }

  // A simulator that shuts down and boots again gets new display objects, and
  // the old ones stop reporting damage; so does its HID client. CoreSimulator
  // returns a new proxy for the same display on every lookup, so the watch
  // follows the device state instead, where 3 is SimDeviceStateBooted.
  private func watch(_ display: SimDisplay) {
    queue.asyncAfter(deadline: .now() + 2) {
      guard CoreSimulator.device(udid: self.udid)?.value(forKey: "state") as? Int != 3 else {
        return self.watch(display)
      }
      display.unregisterDamageCallback(self.callbackID)
      display.unregisterSurfacesCallback(self.callbackID)
      display.unregisterPropertiesCallback(self.callbackID)
      self.display = nil
      self.inputQueue.async { self.hid = nil }
      self.start()
    }
  }

  func configure(_ config: Config) {
    video.configure(enabled: config.video, maxEdge: config.maxEdge, fps: Int(config.fps), bitrate: config.bitrate)
    queue.async {
      self.pacer.config = config
      self.pacer.changed()
    }
  }

  func keyframe() {
    video.requestKeyframe()
    pacer.changed()
  }

  // uiOrientation is a UIInterfaceOrientation; the framebuffer stays in the
  // display's native portrait orientation, so the image is turned upright.
  private func render(_ config: Config) {
    guard let surface = display?.framebufferSurface else { return }
    let orientation: CGImagePropertyOrientation
    let quarterTurns: Int
    switch display?.screenProperties?.uiOrientation ?? 1 {
    case 2: (orientation, quarterTurns) = (.down, 2)
    case 3: (orientation, quarterTurns) = (.right, 3)
    case 4: (orientation, quarterTurns) = (.left, 1)
    default: (orientation, quarterTurns) = (.up, 0)
    }
    let ioSurface = unsafeBitCast(surface, to: IOSurfaceRef.self)
    if config.video {
      var buffer: Unmanaged<CVPixelBuffer>?
      CVPixelBufferCreateWithIOSurface(nil, ioSurface, nil, &buffer)
      if let pixels = buffer?.takeRetainedValue() {
        video.encode(pixels, quarterTurns: quarterTurns, capturedAt: now())
      }
    }
    guard config.jpeg, jpegGate.admit(config, pacer: pacer) else { return }
    let image = CIImage(ioSurface: ioSurface).oriented(orientation)
    guard let (data, width, height) = jpeg(image, config: config) else { return }
    Output.frame(jpeg: data, width: width, height: height)
  }
}

final class EmulatorSource {
  let serial: String
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
  private let jpegGate = JpegGate()

  init(serial: String) {
    self.serial = serial
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
    if config.video { video.encode(rgba: frame.rgba, width: frame.width, height: frame.height, capturedAt: now()) }
    guard config.jpeg, jpegGate.admit(config, pacer: pacer), let provider = CGDataProvider(data: frame.rgba as CFData),
      let image = CGImage(
        width: frame.width, height: frame.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: frame.width * 4,
        space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
      let (data, width, height) = jpeg(CIImage(cgImage: image), config: config)
    else { return }
    Output.frame(jpeg: data, width: width, height: height)
  }
}

enum Command {
  case config(Config)
  case keyframe
  case touch(TouchPhase, CGPoint, display: Int)
  case text(String)
  case button(String)
}

func parseCommand(_ line: String, base: Config) -> Command? {
  guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return nil }
  if object["keyframe"] as? Bool == true { return .keyframe }
  switch object["input"] as? String {
  case "touch":
    let phases: [String: TouchPhase] = ["down": .down, "move": .move, "up": .up]
    guard let phase = (object["phase"] as? String).flatMap({ phases[$0] }),
      let x = object["x"] as? Double, let y = object["y"] as? Double, (0...1).contains(x), (0...1).contains(y)
    else { return nil }
    return .touch(phase, CGPoint(x: x, y: y), display: object["display"] as? Int ?? 0)
  case "text":
    return (object["text"] as? String).map { .text($0) }
  case "button":
    return (object["button"] as? String).map { .button($0) }
  case nil:
    var config = base
    if let fps = object["fps"] as? Double, fps >= 0 { config.fps = min(fps, 60) }
    if let edge = object["maxEdge"] as? Int, edge > 0 { config.maxEdge = min(edge, 4096) }
    if let quality = object["quality"] as? Double, quality > 0, quality <= 1 { config.quality = quality }
    if let jpeg = object["jpeg"] as? Bool { config.jpeg = jpeg }
    if let jpegFps = object["jpegFps"] as? Double, jpegFps > 0 { config.jpegFps = min(jpegFps, 60) }
    if let video = object["video"] as? Bool { config.video = video }
    if let bitrate = object["bitrate"] as? Int, bitrate > 0 { config.bitrate = bitrate }
    return .config(config)
  default:
    return nil
  }
}

protocol Source: AnyObject {
  func configure(_ config: Config)
  func keyframe()
  func input(_ command: Command)
}

func readCommands(_ source: Source) {
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
        switch parseCommand(line, base: config) {
        case .config(let parsed)?:
          config = parsed
          source.configure(config)
        case .keyframe?:
          source.keyframe()
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
    inputQueue.async { self.apply(command) }
  }

  private func apply(_ command: Command) {
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
    case .config, .keyframe:
      break
    }
  }
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
    case .config, .keyframe:
      break
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
guard arguments.count == 3 else { fail("usage: stim-frames ios <udid> | android <serial>") }
switch arguments[1] {
case "ios":
  CoreSimulator.developerDir = CoreSimulator.selectedDeveloperDir()
  guard CoreSimulator.deviceSet != nil else { fail("CoreSimulator could not be loaded from \(CoreSimulator.developerDir).") }
  let source = SimulatorSource(udid: arguments[2])
  Output.requestKeyframe = source.keyframe
  readCommands(source)
  source.queue.async { source.start() }
case "android":
  let source = EmulatorSource(serial: arguments[2])
  Output.requestKeyframe = source.keyframe
  readCommands(source)
  source.start()
default:
  fail("usage: stim-frames ios <udid> | android <serial>")
}
dispatchMain()
