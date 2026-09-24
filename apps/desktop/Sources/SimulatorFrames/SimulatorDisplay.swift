import Foundation
import IOSurface
import ObjectiveC

// CoreSimulator and SimulatorKit are private Apple frameworks. These selectors
// match the SimDisplayIOSurfaceRenderable and SimDisplayRenderable protocols
// that Xcode 27 ships; Apple can change them in any Xcode release.
@objc protocol SimDisplayIOSurfaceRenderable {
  var framebufferSurface: IOSurface? { get }
  @objc(registerCallbackWithUUID:ioSurfacesChangeCallback:)
  func registerSurfacesCallback(_ uuid: NSUUID, _ callback: @escaping (AnyObject?) -> Void)
  @objc(unregisterIOSurfacesChangeCallbackWithUUID:)
  func unregisterSurfacesCallback(_ uuid: NSUUID)
  @objc(registerCallbackWithUUID:damageRectanglesCallback:)
  func registerDamageCallback(_ uuid: NSUUID, _ callback: @escaping (AnyObject?) -> Void)
  @objc(unregisterDamageRectanglesCallbackWithUUID:)
  func unregisterDamageCallback(_ uuid: NSUUID)
}

enum CoreSimulator {
  static let deviceSet: NSObject? = {
    let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
      ?? "/Applications/Xcode.app/Contents/Developer"
    guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil
    else { return nil }
    dlopen("\(developerDir)/../SharedFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW)
    guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type,
      let context = contextClass.perform(
        NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), with: developerDir, with: nil
      )?.takeUnretainedValue() as? NSObject
    else { return nil }
    return context.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?
      .takeUnretainedValue() as? NSObject
  }()

  static func mainDisplay(udid: String) -> SimDisplayIOSurfaceRenderable? {
    guard let set = deviceSet,
      let devices = set.value(forKey: "devices") as? [NSObject],
      let device = devices.first(where: { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }),
      let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject,
      let ports = io.perform(NSSelectorFromString("ioPorts"))?.takeUnretainedValue() as? [NSObject],
      let renderable = objc_getProtocol("SimDisplayIOSurfaceRenderable")
    else { return nil }
    for port in ports {
      guard let descriptor = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject,
        descriptor.conforms(to: renderable)
      else { continue }
      let display = unsafeBitCast(descriptor, to: SimDisplayIOSurfaceRenderable.self)
      if display.framebufferSurface != nil { return display }
    }
    return nil
  }
}
