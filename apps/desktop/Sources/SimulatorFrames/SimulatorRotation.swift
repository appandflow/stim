import Darwin
import Foundation

/// Turns a booted simulator a quarter turn, as Simulator.app's Rotate Left and
/// Rotate Right do. Returns false when the simulator cannot be reached.
public enum SimulatorRotation {
  private static var sent: [String: UInt32] = [:]

  public static func rotate(udid: String, clockwise: Bool) -> Bool {
    guard let device = CoreSimulator.device(udid: udid) else { return false }
    let current = sent[udid] ?? deviceOrientation(interface: CoreSimulator.displays(udid: udid).first?
      .screenProperties?.uiOrientation ?? 1)
    let next = quarterTurn(from: current, clockwise: clockwise)
    guard send(orientation: next, to: device) else { return false }
    sent[udid] = next
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
func deviceOrientation(interface: UInt32) -> UInt32 {
  switch interface {
  case 3: return 4
  case 4: return 3
  case 2: return 2
  default: return 1
  }
}

/// The UIDeviceOrientation a quarter turn from `orientation`.
func quarterTurn(from orientation: UInt32, clockwise: Bool) -> UInt32 {
  let counterclockwise: [UInt32] = [1, 3, 2, 4]
  let index = counterclockwise.firstIndex(of: orientation) ?? 0
  return counterclockwise[(index + (clockwise ? 3 : 1)) % 4]
}
