import Darwin
import Foundation

/// Turns a booted simulator a quarter turn, as Simulator.app's Rotate Left and
/// Rotate Right do. Returns false when the simulator cannot be reached.
/// A CoreSimulator lookup and input activation can block; call this off the main thread.
public enum SimulatorRotation {
  /// Posted after `rotate` turned a simulator; the object is its udid.
  public static let didRotate = Notification.Name("SimulatorRotation.didRotate")
  private static let lock = NSLock()
  private static var sent: [String: (orientation: UInt32, bootedAt: Date?)] = [:]

  /// The UIDeviceOrientation this process last turned the simulator to, or nil before it did.
  /// CoreSimulator reports only the foreground app's orientation, so this is the one record of the device's.
  public static func orientation(udid: String) -> UInt32? {
    lock.lock()
    defer { lock.unlock() }
    return sent[udid]?.orientation
  }

  /// The orientation this process turned the simulator to during the boot that started at `bootedAt`; a simulator
  /// boots upright, so a turn from an earlier boot is nil.
  public static func orientation(udid: String, bootedAt: Date?) -> UInt32? {
    lock.lock()
    defer { lock.unlock() }
    guard let turn = sent[udid], turn.bootedAt == bootedAt else { return nil }
    return turn.orientation
  }

  /// When the simulator last booted, from CoreSimulator's SimDevice `lastBootedAt`.
  public static func bootedAt(udid: String) -> Date? {
    CoreSimulator.device(udid: udid).flatMap(bootedAt(device:))
  }

  private static func bootedAt(device: NSObject) -> Date? {
    guard device.responds(to: NSSelectorFromString("lastBootedAt")) else { return nil }
    return device.value(forKey: "lastBootedAt") as? Date
  }

  /// Drops the remembered orientation of a simulator that shut down: it boots upright.
  public static func forget(udid: String) {
    lock.lock()
    defer { lock.unlock() }
    sent[udid] = nil
  }

  static func remember(_ orientation: UInt32, udid: String, bootedAt: Date?) {
    lock.lock()
    defer { lock.unlock() }
    sent[udid] = (orientation, bootedAt)
  }

  public static func rotate(udid: String, clockwise: Bool) -> Bool {
    guard let device = CoreSimulator.device(udid: udid) else { return false }
    let displays = CoreSimulator.displays(udid: udid).filter { $0.screenProperties?.screenType == 0 }
    let duo = displays.count > 1
    let display = duo ? displays.first { $0.framebufferSurface.map { !isBlack($0) } ?? false } : displays.first
    let booted = bootedAt(device: device)
    let current =
      orientation(udid: udid, bootedAt: booted)
      ?? deviceOrientation(
        interface: display?.screenProperties?.uiOrientation ?? 1,
        innerPanel: duo && display?.screenProperties?.screenID == displays.last?.screenProperties?.screenID)
    let next = quarterTurn(from: current, clockwise: clockwise)
    if duo {
      guard SimulatorPosture.orient(udid: udid, orientation: next) else { return false }
    } else {
      guard send(orientation: next, to: device) else { return false }
    }
    remember(next, udid: udid, bootedAt: booted)
    NotificationCenter.default.post(name: didRotate, object: udid)
    return true
  }

  // GraphicsServices' GSEvent wire format for PurpleWorkspacePort, as Simulator.app
  // sends it: a 108-byte mach message with id 0x7B carrying event type 50
  // (device orientation changed) with the host flag 0x20000, a 4-byte record at
  // 0x48 and the UIDeviceOrientation at 0x4C. facebook/idb documents the layout
  // in PrivateHeaders/SimulatorApp/GSEvent.h.
  private static func send(orientation: UInt32, to device: NSObject) -> Bool {
    typealias Lookup = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> mach_port_t
    let selector = NSSelectorFromString("lookup:error:")
    guard device.responds(to: selector) else { return false }
    let lookup = unsafeBitCast(device.method(for: selector), to: Lookup.self)
    let port = lookup(device, selector, "PurpleWorkspacePort", nil)
    guard port != 0 else { return false }
    var message = [UInt8](repeating: 0, count: 112)
    func write(_ value: UInt32, at offset: Int) {
      withUnsafeBytes(of: value.littleEndian) { message.replaceSubrange(offset..<offset + 4, with: $0) }
    }
    write(0x13, at: 0x00)
    write(108, at: 0x04)
    write(port, at: 0x08)
    write(0x7B, at: 0x14)
    write(50 | 0x20000, at: 0x18)
    write(4, at: 0x48)
    write(orientation, at: 0x4C)
    return message.withUnsafeMutableBytes { bytes in
      let header = bytes.baseAddress!.assumingMemoryBound(to: mach_msg_header_t.self)
      return mach_msg(header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, header.pointee.msgh_size, 0, 0, 2000, 0)
    } == KERN_SUCCESS
  }
}

/// The UIDeviceOrientation that shows a UIInterfaceOrientation upright.
/// The Duo inner panel is natively a quarter turn from its cover panel.
func deviceOrientation(interface: UInt32, innerPanel: Bool = false) -> UInt32 {
  let orientation: UInt32
  switch interface {
  case 3: orientation = 4
  case 4: orientation = 3
  case 2: orientation = 2
  default: orientation = 1
  }
  return innerPanel ? quarterTurn(from: orientation, clockwise: false) : orientation
}

/// The UIDeviceOrientation a quarter turn from `orientation`.
func quarterTurn(from orientation: UInt32, clockwise: Bool) -> UInt32 {
  let counterclockwise: [UInt32] = [1, 3, 2, 4]
  let index = counterclockwise.firstIndex(of: orientation) ?? 0
  return counterclockwise[(index + (clockwise ? 3 : 1)) % 4]
}

/// The UIInterfaceOrientation a single-panel screen is drawn in. A portrait app keeps its portrait
/// framebuffer on a rotated device, so the device orientation turns it, as Simulator.app does. An app
/// that turned itself keeps its own orientation.
func screenOrientation(app: UInt32, device: UInt32?) -> UInt32 {
  guard app == 1, let device else { return app }
  switch device {
  case 3: return 4
  case 4: return 3
  case 2: return 2
  default: return 1
  }
}
