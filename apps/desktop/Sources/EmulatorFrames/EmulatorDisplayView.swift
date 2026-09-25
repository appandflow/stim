import AppKit
import QuartzCore
import StimKit
import SwiftUI

public enum EmulatorStreamStatus: Equatable, Sendable {
  case connecting
  case noEndpoint
  case streaming
}

/// Live frames of a running emulator's main display, read through the gRPC
/// endpoint in its discovery file. When `interactive` is true, clicks, drags,
/// trackpad scrolls and keys go to the emulator over the same endpoint.
/// `onPixelSizeChange` receives the size of the frames as shown, which the
/// emulator already turns upright.
public struct EmulatorDisplayView: NSViewRepresentable {
  public var serial: String
  public var interactive: Bool
  public var onStatus: (EmulatorStreamStatus) -> Void
  public var onPixelSizeChange: (CGSize) -> Void

  public init(
    serial: String, interactive: Bool = false, onStatus: @escaping (EmulatorStreamStatus) -> Void,
    onPixelSizeChange: @escaping (CGSize) -> Void = { _ in }
  ) {
    self.serial = serial
    self.interactive = interactive
    self.onStatus = onStatus
    self.onPixelSizeChange = onPixelSizeChange
  }

  public func makeNSView(context: Context) -> EmulatorDisplayNSView {
    let view = EmulatorDisplayNSView()
    view.onStatus = onStatus
    view.onPixelSizeChange = onPixelSizeChange
    view.attach(serial: serial)
    view.setInteractive(interactive)
    return view
  }

  public func updateNSView(_ view: EmulatorDisplayNSView, context: Context) {
    view.onStatus = onStatus
    view.onPixelSizeChange = onPixelSizeChange
    view.attach(serial: serial)
    view.setInteractive(interactive)
  }

  public static func dismantleNSView(_ view: EmulatorDisplayNSView, coordinator: ()) {
    view.detach()
  }
}

public final class EmulatorDisplayNSView: NSView {
  private static let maxPixels = 960

  var onStatus: ((EmulatorStreamStatus) -> Void)?
  var onPixelSizeChange: (CGSize) -> Void = { _ in }
  private var serial: String?
  private var stream: ScreenshotStream?
  private var retryTimer: Timer?
  private var status: EmulatorStreamStatus?
  private var generation = 0
  private let pending = PendingFrame()
  private var endpoint: EmulatorEndpoint?
  private var shown: (size: CGSize, rotation: Int, folded: CGSize?)?
  private var interactive = false
  private var input: EmulatorInput?
  private var adb: AdbInput?
  private var hasKeyboard: Bool?
  private var displaySize: CGSize?
  private var touchPoint: CGPoint?
  private var keysDown: Set<UInt16> = []
  private var lastShown: CFTimeInterval = 0

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer = CALayer()
    layer?.contentsGravity = .resizeAspect
    layer?.minificationFilter = .trilinear
  }

  required init?(coder: NSCoder) { nil }

  func attach(serial: String) {
    guard serial != self.serial else { return }
    disconnect()
    self.serial = serial
    connect()
  }

  func detach() {
    disconnect()
    serial = nil
  }

  private func disconnect() {
    retryTimer?.invalidate()
    retryTimer = nil
    stream?.cancel()
    stream = nil
    _ = pending.take()
    layer?.contents = nil
    releaseInput()
    shown = nil
    endpoint = nil
  }

  private func connect() {
    guard let serial, window != nil, !framesPaused, stream == nil, retryTimer == nil else { return }
    guard let endpoint = EmulatorDiscovery.endpoint(serial: serial) else {
      report(.noEndpoint)
      retry()
      return
    }
    if endpoint != self.endpoint { releaseInput() }
    self.endpoint = endpoint
    report(.connecting)
    generation += 1
    let current = generation
    var framesSeen = 0
    let stream = ScreenshotStream(
      endpoint: endpoint, width: Self.maxPixels, height: Self.maxPixels,
      onFrame: { [weak self, pending] frame in
        framesSeen += 1
        if framesSeen > 1 { ScreenActivity.shared.record(serial) }
        guard pending.store(frame) else { return }
        DispatchQueue.main.async { self?.frameArrived(current) }
      },
      onEnd: { [weak self] in
        DispatchQueue.main.async {
          guard let self, self.stream != nil, self.generation == current else { return }
          self.stream = nil
          self.report(.connecting)
          self.retry()
        }
      })
    self.stream = stream
    stream.start()
  }

  private func retry() {
    retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      self?.retryTimer = nil
      self?.connect()
    }
  }

  private func frameArrived(_ generation: Int) {
    let wait = lastShown + 1 / AppPreferences.maxFramesPerSecond - CACurrentMediaTime()
    guard wait > 0 else {
      show(pending.take())
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
      guard let self, self.generation == generation else { return }
      self.show(self.pending.take())
    }
  }

  private var framesPaused: Bool {
    AppPreferences.pausesHiddenFrames && window?.occlusionState.contains(.visible) == false
  }

  private func show(_ frame: EmulatorFrame?) {
    guard stream != nil, let frame, let image = Self.image(frame) else { return }
    lastShown = CACurrentMediaTime()
    layer?.contents = image
    let size = CGSize(width: frame.width, height: frame.height)
    if size != shown?.size { onPixelSizeChange(size) }
    self.shown = (size, frame.rotation, frame.folded.map { CGSize(width: $0.width, height: $0.height) })
    _ = inputClient()
    report(.streaming)
  }

  private func report(_ status: EmulatorStreamStatus) {
    guard status != self.status else { return }
    self.status = status
    onStatus?(status)
  }

  private static func image(_ frame: EmulatorFrame) -> CGImage? {
    guard let provider = CGDataProvider(data: frame.rgba as CFData) else { return nil }
    return CGImage(
      width: frame.width, height: frame.height, bitsPerComponent: 8, bitsPerPixel: 32,
      bytesPerRow: frame.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
      provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
  }

  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: nil)
    if let window {
      NotificationCenter.default.addObserver(
        self, selector: #selector(occlusionChanged), name: NSWindow.didChangeOcclusionStateNotification, object: window)
      connect()
    } else {
      disconnect()
    }
  }

  @objc private func occlusionChanged() {
    if framesPaused {
      disconnect()
    } else {
      connect()
    }
  }

  func setInteractive(_ interactive: Bool) {
    guard interactive != self.interactive else { return }
    self.interactive = interactive
    if interactive {
      window?.makeFirstResponder(self)
    } else {
      releaseInput()
    }
  }

  private func releaseInput() {
    if let touchPoint, let input, let displaySize, let shown {
      let native = displayPixel(touchPoint, rotation: shown.rotation, displaySize: shown.folded ?? displaySize)
      input.call("sendMouse", InputMessages.mouse(x: native.x, y: native.y, pressed: false))
    }
    for code in keysDown { input?.call("sendKey", InputMessages.key(macKeyCode: code, down: false)) }
    touchPoint = nil
    keysDown = []
    input?.close()
    input = nil
    adb = nil
    hasKeyboard = nil
    displaySize = nil
  }

  private func inputClient() -> EmulatorInput? {
    guard interactive, let endpoint, shown != nil else { return nil }
    if let input { return input }
    let input = EmulatorInput(endpoint: endpoint)
    self.input = input
    input.call("getStatus", Data()) { [weak self, weak input] response in
      guard let response else { return }
      let size = InputMessages.displaySize(fromStatus: response)
      let keyboard = InputMessages.hasKeyboard(fromStatus: response)
      DispatchQueue.main.async {
        guard let self, input != nil, input === self.input else { return }
        if let size { self.displaySize = CGSize(width: size.width, height: size.height) }
        self.hasKeyboard = keyboard
      }
    }
    return input
  }

  private func screenPoint(_ event: NSEvent, clamped: Bool) -> CGPoint? {
    guard let shown else { return nil }
    return normalizedScreenPoint(
      convert(event.locationInWindow, from: nil), viewSize: bounds.size, screenSize: shown.size, clamped: clamped)
  }

  private func mouse(at point: CGPoint, pressed: Bool) {
    guard let input = inputClient(), let displaySize, let shown else { return }
    let native = displayPixel(point, rotation: shown.rotation, displaySize: shown.folded ?? displaySize)
    input.call("sendMouse", InputMessages.mouse(x: native.x, y: native.y, pressed: pressed))
    touchPoint = pressed ? point : nil
  }

  public override var acceptsFirstResponder: Bool { interactive }

  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { interactive }

  public override func mouseDown(with event: NSEvent) {
    guard interactive else { return super.mouseDown(with: event) }
    window?.makeFirstResponder(self)
    guard touchPoint == nil, let point = screenPoint(event, clamped: false) else { return }
    mouse(at: point, pressed: true)
  }

  public override func mouseDragged(with event: NSEvent) {
    guard touchPoint != nil, let point = screenPoint(event, clamped: true) else { return }
    mouse(at: point, pressed: true)
  }

  public override func mouseUp(with event: NSEvent) {
    guard let last = touchPoint else { return }
    mouse(at: screenPoint(event, clamped: true) ?? last, pressed: false)
  }

  // A trackpad scroll becomes a one-finger drag that follows the gesture's
  // phases, as on iOS. Momentum events are dropped because Android flings on
  // its own after the finger lifts.
  public override func scrollWheel(with event: NSEvent) {
    guard interactive, event.hasPreciseScrollingDeltas, event.momentumPhase.isEmpty else {
      return super.scrollWheel(with: event)
    }
    if event.phase.contains(.began) {
      guard touchPoint == nil, let point = screenPoint(event, clamped: false) else { return }
      mouse(at: point, pressed: true)
    } else if let last = touchPoint, let shown {
      let fitted = fittedScreenSize(viewSize: bounds.size, screenSize: shown.size)
      guard fitted.width > 0, fitted.height > 0 else { return }
      let point = CGPoint(
        x: min(max(last.x + event.scrollingDeltaX / fitted.width, 0), 1),
        y: min(max(last.y + event.scrollingDeltaY / fitted.height, 0), 1))
      let ended = event.phase.contains(.ended) || event.phase.contains(.cancelled)
      mouse(at: point, pressed: !ended)
    }
  }

  // Printable ASCII goes as text so the emulator picks the evdev keys and
  // Shift itself; other keys go as macOS key codes, which the emulator
  // translates. An emulator without a hardware keyboard drops both, so its
  // keys go through `adb shell input`. Command and Control shortcuts stay with
  // the Mac.
  public override func keyDown(with event: NSEvent) {
    guard !event.modifierFlags.contains(.command), !event.modifierFlags.contains(.control),
      let input = inputClient()
    else { return super.keyDown(with: event) }
    let text = event.characters.flatMap { isPrintableASCII($0) ? $0 : nil }
    if hasKeyboard == false, let serial {
      let adb = self.adb ?? AdbInput(serial: serial)
      self.adb = adb
      if let text {
        adb.text(text)
      } else if let key = androidKeyEvent(macKeyCode: event.keyCode) {
        adb.keyEvent(key)
      }
    } else if let text {
      input.call("sendKey", InputMessages.text(text))
    } else if !event.isARepeat {
      keysDown.insert(event.keyCode)
      input.call("sendKey", InputMessages.key(macKeyCode: event.keyCode, down: true))
    }
  }

  public override func keyUp(with event: NSEvent) {
    guard keysDown.remove(event.keyCode) != nil, let input = inputClient() else { return super.keyUp(with: event) }
    input.call("sendKey", InputMessages.key(macKeyCode: event.keyCode, down: false))
  }
}

/// The Android key event `adb shell input keyevent` takes for a macOS virtual
/// key code that types no text.
func androidKeyEvent(macKeyCode: UInt16) -> String? {
  let keys: [UInt16: String] = [
    0x24: "KEYCODE_ENTER", 0x4C: "KEYCODE_ENTER", 0x30: "KEYCODE_TAB", 0x33: "KEYCODE_DEL",
    0x75: "KEYCODE_FORWARD_DEL", 0x35: "KEYCODE_ESCAPE", 0x73: "KEYCODE_MOVE_HOME", 0x77: "KEYCODE_MOVE_END",
    0x74: "KEYCODE_PAGE_UP", 0x79: "KEYCODE_PAGE_DOWN", 0x7B: "KEYCODE_DPAD_LEFT", 0x7C: "KEYCODE_DPAD_RIGHT",
    0x7D: "KEYCODE_DPAD_DOWN", 0x7E: "KEYCODE_DPAD_UP",
  ]
  return keys[macKeyCode]
}

/// `adb shell input` for one emulator, one command at a time in order.
private final class AdbInput {
  private let serial: String
  private let queue = DispatchQueue(label: "stim.emulator-adb")

  init(serial: String) {
    self.serial = serial
  }

  // `adb shell` joins its arguments into one device shell command, so text
  // goes single-quoted; `input text` reads `%s` as a space.
  func text(_ text: String) {
    let quoted = text.replacingOccurrences(of: " ", with: "%s").replacingOccurrences(of: "'", with: "'\\''")
    run(["shell", "input", "text", "'\(quoted)'"])
  }

  func keyEvent(_ key: String) {
    run(["shell", "input", "keyevent", key])
  }

  private func run(_ arguments: [String]) {
    let serial = serial
    queue.async {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: Self.adbPath)
      process.arguments = ["-s", serial] + arguments
      process.standardInput = FileHandle.nullDevice
      process.standardOutput = FileHandle.nullDevice
      process.standardError = FileHandle.nullDevice
      guard (try? process.run()) != nil else { return }
      let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
      DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: timeout)
      process.waitUntilExit()
      timeout.cancel()
    }
  }

  private static let adbPath: String = {
    let environment = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let sdks = [environment["ANDROID_HOME"], environment["ANDROID_SDK_ROOT"], "\(home)/Library/Android/sdk"]
    for case let sdk? in sdks where FileManager.default.isExecutableFile(atPath: "\(sdk)/platform-tools/adb") {
      return "\(sdk)/platform-tools/adb"
    }
    return "/opt/homebrew/bin/adb"
  }()
}

func isPrintableASCII(_ text: String) -> Bool {
  !text.isEmpty && text.unicodeScalars.allSatisfy { (32..<127).contains($0.value) }
}

private final class PendingFrame: @unchecked Sendable {
  private let lock = NSLock()
  private var frame: EmulatorFrame?

  func store(_ frame: EmulatorFrame) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let wasEmpty = self.frame == nil
    self.frame = frame
    return wasEmpty
  }

  func take() -> EmulatorFrame? {
    lock.lock()
    defer { lock.unlock() }
    defer { frame = nil }
    return frame
  }
}
