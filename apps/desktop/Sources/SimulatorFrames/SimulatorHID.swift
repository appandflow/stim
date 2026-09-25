import AppKit
import ObjectiveC

// SimulatorKit's HID client and Indigo message builders are private. These
// signatures match the assertion strings and ObjC type encodings that Xcode 27
// ships. Touch points are fractions of the screen when the size is 1x1, and
// 0x32 is the Indigo target of the main screen's digitizer.
private typealias AllocFn = @convention(c) (AnyClass, Selector) -> Unmanaged<AnyObject>
private typealias InitFn = @convention(c) (
  Unmanaged<AnyObject>, Selector, AnyObject, UnsafeMutablePointer<Unmanaged<NSError>?>?
) -> Unmanaged<AnyObject>?
private typealias SendFn = @convention(c) (
  AnyObject, Selector, UnsafeMutableRawPointer, Bool, DispatchQueue?, (@convention(block) (NSError?) -> Void)?
) -> Void
private typealias MouseMessageFn = @convention(c) (
  UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?, UInt32, UInt, CGSize, UInt32
) -> UnsafeMutableRawPointer?
private typealias KeyboardMessageFn = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
private typealias UsageForKeyCodeFn = @convention(c) (UInt32) -> UInt32
private typealias ButtonMessageFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
private typealias HIDMessageFn = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?

private enum SimulatorKit {
  static let handle = dlopen(CoreSimulator.simulatorKitPath(CoreSimulator.developerDir), RTLD_NOW)
  static let mouseMessage = symbol("IndigoHIDMessageForMouseNSEvent", MouseMessageFn.self)
  static let keyboardMessage = symbol("IndigoHIDMessageForKeyboardArbitrary", KeyboardMessageFn.self)
  static let usageForKeyCode = symbol("hidUsageForCGKeyCode", UsageForKeyCodeFn.self)
  static let buttonMessage = symbol("IndigoHIDMessageForButton", ButtonMessageFn.self)
  static let hidMessage = symbol("IndigoHIDMessageForHIDArbitrary", HIDMessageFn.self)

  static func symbol<T>(_ name: String, _ type: T.Type) -> T? {
    guard let handle, let pointer = dlsym(handle, name) else { return nil }
    return unsafeBitCast(pointer, to: type)
  }
}

// Indigo event sources for IndigoHIDMessageForButton; SimulatorKit exports
// no names for them.
enum SimulatorButton: UInt32 {
  case home = 0x0
  case lock = 0xbb8
}

enum TouchPhase {
  case down, move, up

  var eventType: NSEvent.EventType {
    switch self {
    case .down: return .leftMouseDown
    case .move: return .leftMouseDragged
    case .up: return .leftMouseUp
    }
  }
}

final class SimulatorHID {
  private static let mainScreenTarget: UInt32 = 0x32
  private static let keyboardPage: UInt32 = 0x07
  private static let keyDown: UInt32 = 1
  private static let keyUp: UInt32 = 2
  private static let sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")

  private let client: AnyObject
  private let send: SendFn

  init?(udid: String) {
    let allocSelector = NSSelectorFromString("alloc")
    let initSelector = NSSelectorFromString("initWithDevice:error:")
    guard SimulatorKit.handle != nil,
      let device = CoreSimulator.device(udid: udid),
      let cls = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient"),
      let metaclass = object_getClass(cls),
      class_respondsToSelector(metaclass, allocSelector),
      class_respondsToSelector(cls, initSelector),
      class_respondsToSelector(cls, Self.sendSelector)
    else { return nil }
    let alloc = unsafeBitCast(class_getMethodImplementation(metaclass, allocSelector), to: AllocFn.self)
    let initialize = unsafeBitCast(class_getMethodImplementation(cls, initSelector), to: InitFn.self)
    guard let client = initialize(alloc(cls, allocSelector), initSelector, device, nil)?.takeRetainedValue()
    else { return nil }
    self.client = client
    send = unsafeBitCast(class_getMethodImplementation(cls, Self.sendSelector), to: SendFn.self)
  }

  // The simulator's SimulatorHID addresses a display's digitizer by its screen
  // ID with bit 30 set, and backboardd aborts on a target it has no service
  // for. The main display keeps its legacy target.
  static func digitizerTarget(screenID: UInt32) -> UInt32 {
    screenID == 1 ? mainScreenTarget : 0x4000_0000 | screenID
  }

  /// `point` is a fraction of the screen, origin top-left.
  func touch(_ phase: TouchPhase, at point: CGPoint, screenID: UInt32 = 1) {
    let target = Self.digitizerTarget(screenID: screenID)
    var point = point
    // The builder returns nil for a drag that arrives within 16 ms of the previous message.
    guard let message = SimulatorKit.mouseMessage?(
      &point, nil, target, UInt(phase.eventType.rawValue), CGSize(width: 1, height: 1), 0)
    else { return }
    deliver(message)
  }

  func key(code: UInt16, down: Bool) {
    guard let usage = SimulatorKit.usageForKeyCode?(UInt32(code)), usage != 0,
      let message = SimulatorKit.keyboardMessage?(usage, down ? Self.keyDown : Self.keyUp)
    else { return }
    deliver(message)
  }

  // On Xcode 27 a headless simulator ignores keyboard messages sent to
  // IndigoHIDMessageForKeyboardArbitrary's fixed target (0x64) and button
  // messages sent to 0x33; both arrive through the main screen's target.

  /// Presses or releases a key, named by its macOS virtual key code.
  func hardwareKey(code: UInt16, down: Bool) {
    guard let usage = SimulatorKit.usageForKeyCode?(UInt32(code)), usage != 0,
      let message = SimulatorKit.hidMessage?(Self.mainScreenTarget, Self.keyboardPage, usage, down ? Self.keyDown : Self.keyUp)
    else { return }
    deliver(message)
  }

  /// Presses or releases a hardware button, named by its Indigo event source.
  func button(_ button: SimulatorButton, down: Bool) {
    guard let message = SimulatorKit.buttonMessage?(button.rawValue, down ? Self.keyDown : Self.keyUp, Self.mainScreenTarget)
    else { return }
    deliver(message)
  }

  private func deliver(_ message: UnsafeMutableRawPointer) {
    send(client, Self.sendSelector, message, true, nil, nil)
  }
}

/// Maps a fraction of the upright screen, origin top-left, to a fraction of
/// the framebuffer in its native portrait orientation, which is what the
/// simulator's digitizer expects. `orientation` is a UIInterfaceOrientation.
func nativeScreenPoint(_ point: CGPoint, orientation: UInt32) -> CGPoint {
  switch orientation {
  case 2: return CGPoint(x: 1 - point.x, y: 1 - point.y)
  case 3: return CGPoint(x: point.y, y: 1 - point.x)
  case 4: return CGPoint(x: 1 - point.y, y: point.x)
  default: return point
  }
}

/// Whether a grid of samples across a BGRA framebuffer is all black. A lit
/// screen shows at least a status bar, so a dark app still has non-black pixels.
func isBlack(_ surface: IOSurface) -> Bool {
  surface.lock(options: .readOnly, seed: nil)
  defer { surface.unlock(options: .readOnly, seed: nil) }
  let bytes = surface.baseAddress.assumingMemoryBound(to: UInt8.self)
  let rowStep = max(surface.height / 64, 1)
  let columnStep = max(surface.width / 48, 1)
  for y in stride(from: 0, to: surface.height, by: rowStep) {
    for x in stride(from: 0, to: surface.width, by: columnStep) {
      let offset = y * surface.bytesPerRow + x * 4
      if bytes[offset] | bytes[offset + 1] | bytes[offset + 2] != 0 { return false }
    }
  }
  return true
}
