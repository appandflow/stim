import Foundation
import ObjectiveC

/// Guest development controls on a selected iOS simulator. CoreSimulator calls can block; use off the main thread.
public enum SimulatorDevelopmentOptions {
  public struct Settings: Sendable {
    public let slowAnimations: Bool?
    public let canShake: Bool
  }

  // UIKit consumes the state of this Darwin notification when it is posted, as
  // Siniulator's Input.swift does (e181521a32595c2e537e1ee6c359aae254dbfed3).
  private static let slowAnimationNotification = "com.apple.UIKit.SimulatorSlowMotionAnimationState"
  private static let readSelector = NSSelectorFromString("darwinNotificationGetState:name:error:")
  private static let setSelector = NSSelectorFromString("darwinNotificationSetState:name:error:")
  private static let postSelector = NSSelectorFromString("postDarwinNotification:error:")

  public static func read(udid: String) throws -> Settings {
    let device = try selectedDevice(udid)
    let canPost = device.responds(to: postSelector)
    let canSetSlow = canPost && device.responds(to: readSelector) && device.responds(to: setSelector)
    return Settings(slowAnimations: canSetSlow ? try state(device) != 0 : nil, canShake: canPost)
  }

  public static func setSlowAnimations(_ enabled: Bool, udid: String) throws -> Settings {
    let device = try selectedDevice(udid)
    guard device.responds(to: setSelector), device.responds(to: readSelector), device.responds(to: postSelector) else {
      throw Failure.unavailable
    }
    typealias Set = @convention(c) (AnyObject, Selector, UInt64, NSString, UnsafeMutablePointer<NSError?>?) -> Bool
    let set = unsafeBitCast(device.method(for: setSelector), to: Set.self)
    var error: NSError?
    guard set(device, setSelector, enabled ? 1 : 0, slowAnimationNotification as NSString, &error) else {
      throw error ?? Failure.unavailable
    }
    try post(slowAnimationNotification, device: device)
    let settings = try read(udid: udid)
    guard settings.slowAnimations == enabled else { throw Failure.unconfirmed }
    return settings
  }

  public static func shake(udid: String) throws {
    try post("com.apple.UIKit.SimulatorShake", device: selectedDevice(udid))
  }

  private static func selectedDevice(_ udid: String) throws -> NSObject {
    guard let device = CoreSimulator.device(udid: udid) else { throw Failure.unavailable }
    return device
  }

  private static func state(_ device: NSObject) throws -> UInt64 {
    typealias Read =
      @convention(c) (AnyObject, Selector, UnsafeMutablePointer<UInt64>, NSString, UnsafeMutablePointer<NSError?>?) -> Bool
    let read = unsafeBitCast(device.method(for: readSelector), to: Read.self)
    var value: UInt64 = 0
    var error: NSError?
    guard read(device, readSelector, &value, slowAnimationNotification as NSString, &error) else {
      throw error ?? Failure.unavailable
    }
    return value
  }

  private static func post(_ name: String, device: NSObject) throws {
    guard device.responds(to: postSelector) else { throw Failure.unavailable }
    typealias Post = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> Bool
    let post = unsafeBitCast(device.method(for: postSelector), to: Post.self)
    var error: NSError?
    guard post(device, postSelector, name as NSString, &error) else { throw error ?? Failure.unavailable }
  }

  private enum Failure: LocalizedError {
    case unavailable, unconfirmed

    var errorDescription: String? {
      switch self {
      case .unavailable: return "Development controls are unavailable for this simulator."
      case .unconfirmed: return "The simulator did not confirm the animation setting."
      }
    }
  }
}
