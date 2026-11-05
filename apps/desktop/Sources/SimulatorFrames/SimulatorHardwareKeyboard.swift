import Foundation
import ObjectiveC

/// Puts an iOS simulator in hardware-keyboard mode, the setting behind Simulator.app's Connect Hardware Keyboard, so
/// the simulator draws no on-screen keyboard while a host keyboard types into it.
enum SimulatorHardwareKeyboard {
  private typealias SetFn =
    @convention(c) (AnyObject, Selector, Bool, UInt, UnsafeMutablePointer<NSError?>?) -> Bool
  private static let selector = NSSelectorFromString("setHardwareKeyboardEnabled:keyboardType:error:")

  // CoreSimulator applies the call only when its arguments differ from the last ones it saw, and XCTest's
  // testmanagerd detaches the keyboard without telling it. Two keyboard types in a row attach it again from either
  // state, and the keyboard never detaches in between.
  private static let keyboardTypes: [UInt] = [0, 33]

  @discardableResult
  static func attach(to device: NSObject) -> Bool {
    guard device.responds(to: selector) else { return false }
    let set = unsafeBitCast(device.method(for: selector), to: SetFn.self)
    var attached = true
    for type in keyboardTypes {
      var error: NSError?
      attached = set(device, selector, true, type, &error) && attached
    }
    return attached
  }

  @discardableResult
  static func detach(from device: NSObject) -> Bool {
    guard device.responds(to: selector) else { return false }
    let set = unsafeBitCast(device.method(for: selector), to: SetFn.self)
    var error: NSError?
    return set(device, selector, false, 0, &error)
  }
}
