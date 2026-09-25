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

private enum SimulatorKit {
  static let handle = dlopen(CoreSimulator.simulatorKitPath(CoreSimulator.developerDir), RTLD_NOW)
  static let mouseMessage = symbol("IndigoHIDMessageForMouseNSEvent", MouseMessageFn.self)
  static let keyboardMessage = symbol("IndigoHIDMessageForKeyboardArbitrary", KeyboardMessageFn.self)
  static let usageForKeyCode = symbol("hidUsageForCGKeyCode", UsageForKeyCodeFn.self)

  static func symbol<T>(_ name: String, _ type: T.Type) -> T? {
    guard let handle, let pointer = dlsym(handle, name) else { return nil }
    return unsafeBitCast(pointer, to: type)
  }
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

  private func deliver(_ message: UnsafeMutableRawPointer) {
    send(client, Self.sendSelector, message, true, nil, nil)
  }
}
