import AppKit
import ObjectiveC
import XPC

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
private typealias UsageForKeyCodeFn = @convention(c) (UInt32) -> UInt32
private typealias ButtonMessageFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
private typealias HIDMessageFn = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?

private enum SimulatorKit {
  static let handle = dlopen(CoreSimulator.simulatorKitPath(CoreSimulator.developerDir), RTLD_NOW)
  static let mouseMessage = symbol("IndigoHIDMessageForMouseNSEvent", MouseMessageFn.self)
  static let usageForKeyCode = symbol("hidUsageForCGKeyCode", UsageForKeyCodeFn.self)
  static let buttonMessage = symbol("IndigoHIDMessageForButton", ButtonMessageFn.self)
  static let hidMessage = symbol("IndigoHIDMessageForHIDArbitrary", HIDMessageFn.self)

  static func symbol<T>(_ name: String, _ type: T.Type) -> T? {
    guard let handle, let pointer = dlsym(handle, name) else { return nil }
    return unsafeBitCast(pointer, to: type)
  }
}

// Indigo event sources for IndigoHIDMessageForButton, and the HID consumer
// usages CoreDevice takes for the same buttons; SimulatorKit exports no names
// for them.
enum SimulatorButton {
  case home, lock

  var indigoSource: UInt32 {
    switch self {
    case .home: return 0x0
    case .lock: return 0xbb8
    }
  }

  var consumerUsage: UInt64 {
    switch self {
    case .home: return 0x40
    case .lock: return 0x30
    }
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

/// Input for one booted simulator. It uses the simulator's CoreDevice HID
/// service when the runtime has one, and SimulatorKit's legacy HID client
/// otherwise. `isConnected` turns false once the CoreDevice connection closes,
/// and a few seconds after falling back to the legacy client, so a service
/// that was not up yet is tried again; make a new instance then.
final class SimulatorHID {
  private let transport: Transport
  private let legacyUntil = Date().addingTimeInterval(10)

  private enum Transport {
    case coreDevice(CoreDeviceHID)
    case legacy(LegacyHID)
  }

  init?(udid: String) {
    guard let device = CoreSimulator.device(udid: udid) else { return nil }
    if let coreDevice = CoreDeviceHID(device: device) {
      transport = .coreDevice(coreDevice)
    } else if let legacy = LegacyHID(device: device) {
      transport = .legacy(legacy)
    } else {
      return nil
    }
  }

  var isConnected: Bool {
    if case .coreDevice(let coreDevice) = transport { return coreDevice.isConnected }
    return Date() < legacyUntil
  }

  /// `point` is a fraction of the screen in its native orientation, origin top-left.
  func touch(_ phase: TouchPhase, at point: CGPoint, screenID: UInt32 = 1) {
    switch transport {
    case .coreDevice(let coreDevice): coreDevice.touch(phase, at: point, screenID: screenID)
    case .legacy(let legacy): legacy.touch(phase, at: point, screenID: screenID)
    }
  }

  /// Presses or releases a key, named by its macOS virtual key code.
  func hardwareKey(code: UInt16, down: Bool) {
    guard let usage = SimulatorKit.usageForKeyCode?(UInt32(code)), usage != 0 else { return }
    switch transport {
    case .coreDevice(let coreDevice): coreDevice.key(usage: UInt64(usage), down: down)
    case .legacy(let legacy): legacy.key(usage: usage, down: down)
    }
  }

  func button(_ button: SimulatorButton, down: Bool) {
    switch transport {
    case .coreDevice(let coreDevice): coreDevice.button(usage: button.consumerUsage, down: down)
    case .legacy(let legacy): legacy.button(source: button.indigoSource, down: down)
    }
  }
}

// Once a CoreDevice client such as Device Hub starts dtuhidd in the simulator,
// the guest ignores SimulatorKit's legacy HID client until it reboots; dtuhidd's
// own service takes input in both states. The message shapes follow dtuhidd's
// IndigoHIDServer as Siniulator uses it
// (github.com/kmagiera/Siniulator, Sources/Siniulator/Input.swift).
private final class CoreDeviceHID {
  private static let feature = "com.apple.coredevice.feature.remote.hid.digitizer"
  private static let lookupSelector = NSSelectorFromString("lookup:error:")

  private typealias LookupFn = @convention(c) (
    AnyObject, Selector, NSString, UnsafeMutablePointer<Unmanaged<NSError>?>?
  ) -> mach_port_t
  private typealias EndpointFn = @convention(c) (mach_port_t, UInt64, UInt64) -> xpc_object_t?
  private typealias EnableFn = @convention(c) (xpc_connection_t) -> Void

  private let connection: xpc_connection_t
  private let lock = NSLock()
  private var closed = false
  private var pending: [xpc_object_t]? = []

  init?(device: NSObject) {
    let process = dlopen(nil, RTLD_NOW)
    guard device.responds(to: Self.lookupSelector),
      let createEndpoint = dlsym(process, "xpc_endpoint_create_mach_port_4sim"),
      let enableSimToHost = dlsym(process, "xpc_connection_enable_sim2host_4sim")
    else { return nil }
    let lookup = unsafeBitCast(device.method(for: Self.lookupSelector), to: LookupFn.self)
    let port = lookup(device, Self.lookupSelector, Self.feature as NSString, nil)
    guard port != 0, let endpoint = unsafeBitCast(createEndpoint, to: EndpointFn.self)(port, 0, 0) else { return nil }
    connection = xpc_connection_create_from_endpoint(endpoint)
    unsafeBitCast(enableSimToHost, to: EnableFn.self)(connection)
    let queue = DispatchQueue(label: "stim.simulator-hid")
    xpc_connection_set_target_queue(connection, queue)
    xpc_connection_set_event_handler(connection) { [weak self] event in
      guard xpc_get_type(event) == XPC_TYPE_ERROR, let self else { return }
      self.lock.lock()
      self.closed = true
      self.pending = nil
      self.lock.unlock()
    }
    xpc_connection_resume(connection)
    // dtuhidd drops events that arrive before it has answered the activating
    // barrier; a barrier left unanswered fails the connection.
    let activation = message("IndigoKeyboardButtonEvent", dictionary(["usageCode": 0, "state": 2]), barrier: true)
    xpc_connection_send_message_with_reply(connection, activation, queue) { [weak self] reply in
      guard xpc_get_type(reply) != XPC_TYPE_ERROR, let self else { return }
      self.lock.lock()
      let queued = self.pending ?? []
      self.pending = nil
      for message in queued { xpc_connection_send_message(self.connection, message) }
      self.lock.unlock()
    }
    queue.asyncAfter(deadline: .now() + 5) { [weak self] in
      guard let self else { return }
      self.lock.lock()
      if self.pending != nil {
        self.closed = true
        self.pending = nil
      }
      self.lock.unlock()
    }
  }

  deinit {
    xpc_connection_cancel(connection)
  }

  var isConnected: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !closed
  }

  // dtuhidd's DigitizerTarget is 0 for the main screen and the screen ID for any other display.
  func touch(_ phase: TouchPhase, at point: CGPoint, screenID: UInt32) {
    let contact = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_double(contact, "x", point.x)
    xpc_dictionary_set_double(contact, "y", point.y)
    let payload = dictionary([
      "eventType": phase == .down ? 0 : phase == .move ? 1 : 2, "edge": 0, "target": UInt64(screenID == 1 ? 0 : screenID),
    ])
    xpc_dictionary_set_value(payload, "pointOne", contact)
    send("IndigoDigitizerEvent", payload)
  }

  func key(usage: UInt64, down: Bool) {
    send("IndigoKeyboardButtonEvent", ["usageCode": usage, "state": down ? 1 : 2])
  }

  func button(usage: UInt64, down: Bool) {
    send("IndigoButtonEvent", ["usagePage": 0x0c, "usageCode": usage, "state": down ? 1 : 2])
  }

  private func send(_ type: String, _ values: [String: UInt64]) {
    send(type, dictionary(values))
  }

  private func send(_ type: String, _ payload: xpc_object_t) {
    let message = message(type, payload, barrier: false)
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { return }
    if pending != nil {
      pending?.append(message)
    } else {
      xpc_connection_send_message(connection, message)
    }
  }

  private func message(_ type: String, _ payload: xpc_object_t, barrier: Bool) -> xpc_object_t {
    let message = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_string(message, "messageType", type)
    xpc_dictionary_set_bool(message, "isBarrier", barrier)
    xpc_dictionary_set_string(message, "featureIdentifier", Self.feature)
    xpc_dictionary_set_value(message, "payload", payload)
    return message
  }

  private func dictionary(_ values: [String: UInt64]) -> xpc_object_t {
    let object = xpc_dictionary_create(nil, nil, 0)
    for (key, value) in values { xpc_dictionary_set_uint64(object, key, value) }
    return object
  }
}

// SimulatorKit's HID client and Indigo message builders are private. These
// signatures match the assertion strings and ObjC type encodings that Xcode 27
// ships. Touch points are fractions of the screen when the size is 1x1, and
// 0x32 is the Indigo target of the main screen's digitizer. Keys and buttons
// also go to 0x32: the keyboard (0x64) and button (0x33) targets stop working
// once the guest suppresses those services.
private final class LegacyHID {
  private static let mainScreenTarget: UInt32 = 0x32
  private static let keyboardPage: UInt32 = 0x07
  private static let keyDown: UInt32 = 1
  private static let keyUp: UInt32 = 2
  private static let sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")

  private let client: AnyObject
  private let send: SendFn

  init?(device: NSObject) {
    let allocSelector = NSSelectorFromString("alloc")
    let initSelector = NSSelectorFromString("initWithDevice:error:")
    guard SimulatorKit.handle != nil,
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
  func touch(_ phase: TouchPhase, at point: CGPoint, screenID: UInt32) {
    let target = screenID == 1 ? Self.mainScreenTarget : 0x4000_0000 | screenID
    var point = point
    // The builder returns nil for a drag that arrives within 16 ms of the previous message.
    guard let message = SimulatorKit.mouseMessage?(
      &point, nil, target, UInt(phase.eventType.rawValue), CGSize(width: 1, height: 1), 0)
    else { return }
    deliver(message)
  }

  func key(usage: UInt32, down: Bool) {
    guard let message = SimulatorKit.hidMessage?(Self.mainScreenTarget, Self.keyboardPage, usage, down ? Self.keyDown : Self.keyUp)
    else { return }
    deliver(message)
  }

  func button(source: UInt32, down: Bool) {
    guard let message = SimulatorKit.buttonMessage?(source, down ? Self.keyDown : Self.keyUp, Self.mainScreenTarget)
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
