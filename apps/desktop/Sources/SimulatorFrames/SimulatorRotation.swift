import Darwin
import Foundation

/// Turns a booted simulator a quarter turn, as Simulator.app's Rotate Left and
/// Rotate Right do. Returns false when the simulator cannot be reached.
/// CoreSimulator lookup and input activation run in a bounded background attempt.
public enum SimulatorRotation {
  private static let lock = NSLock()
  private static var sent: [String: UInt32] = [:]

  public static func rotate(udid: String, clockwise: Bool) async -> Bool {
    (try? await SimulatorLookup.run(udid: udid) { sendRotation(udid: udid, clockwise: clockwise) }) ?? false
  }

  private static func sendRotation(udid: String, clockwise: Bool) -> Bool {
    guard let device = CoreSimulator.device(udid: udid) else { return false }
    let displays = CoreSimulator.displays(udid: udid).filter { $0.screenProperties?.screenType == 0 }
    let duo = displays.count > 1
    let display = duo ? displays.first { $0.framebufferSurface.map { !isBlack($0) } ?? false } : displays.first
    lock.lock()
    let remembered = sent[udid]
    lock.unlock()
    let current =
      remembered
      ?? deviceOrientation(
        interface: display?.screenProperties?.uiOrientation ?? 1,
        innerPanel: duo && display?.screenProperties?.screenID == displays.last?.screenProperties?.screenID)
    let next = quarterTurn(from: current, clockwise: clockwise)
    if duo {
      guard SimulatorPosture.orient(udid: udid, orientation: next) else { return false }
    } else {
      guard send(orientation: next, to: device) else { return false }
    }
    lock.lock()
    sent[udid] = next
    lock.unlock()
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
