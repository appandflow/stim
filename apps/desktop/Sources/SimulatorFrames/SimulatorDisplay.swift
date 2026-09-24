import Foundation
import IOSurface
import ObjectiveC

// CoreSimulator and SimulatorKit are private Apple frameworks. These selectors
// match the SimDisplayIOSurfaceRenderable, SimDisplayRenderable, SimScreen and
// SimScreenProperties protocols that Xcode 27 ships; Apple can change them in
// any Xcode release.
@objc protocol SimDisplayIOSurfaceRenderable {
  var framebufferSurface: IOSurface? { get }
  @objc(registerCallbackWithUUID:ioSurfacesChangeCallback:)
  func registerSurfacesCallback(_ uuid: NSUUID, _ callback: @escaping (AnyObject?) -> Void)
  @objc(unregisterIOSurfacesChangeCallbackWithUUID:)
  func unregisterSurfacesCallback(_ uuid: NSUUID)
}

@objc protocol SimDisplayRenderable {
  @objc(registerCallbackWithUUID:damageRectanglesCallback:)
  func registerDamageCallback(_ uuid: NSUUID, _ callback: @escaping (AnyObject?) -> Void)
  @objc(unregisterDamageRectanglesCallbackWithUUID:)
  func unregisterDamageCallback(_ uuid: NSUUID)
  @objc(registerCallbackWithUUID:displayPropertiesChanged:)
  func registerPropertiesCallback(_ uuid: NSUUID, _ callback: @escaping (AnyObject?) -> Void)
  @objc(unregisterDisplayPropertiesChangedCallbackWithUUID:)
  func unregisterPropertiesCallback(_ uuid: NSUUID)
}

@objc protocol SimScreen {
  var screenProperties: SimScreenProperties? { get }
}

// uiOrientation is a UIInterfaceOrientation; the framebuffer stays in the
// display's native portrait orientation when the device rotates.
@objc protocol SimScreenProperties {
  var uiOrientation: UInt32 { get }
}

typealias SimDisplay = SimDisplayIOSurfaceRenderable & SimDisplayRenderable & SimScreen

public enum CoreSimulator {
  /// The Xcode developer directory CoreSimulator loads SimulatorKit from.
  /// Set it once at launch, before any view shows simulator frames.
  public static var developerDir = defaultDeveloperDir

  private static var defaultDeveloperDir: String {
    ProcessInfo.processInfo.environment["DEVELOPER_DIR"] ?? "/Applications/Xcode.app/Contents/Developer"
  }

  /// The developer directory `xcode-select -p` reports, or `DEVELOPER_DIR`,
  /// or `/Applications/Xcode.app`, when the selected one has no SimulatorKit.
  public static func selectedDeveloperDir() -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    process.arguments = ["-p"]
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return defaultDeveloperDir }
    let path = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return FileManager.default.fileExists(atPath: simulatorKitPath(path)) ? path : defaultDeveloperDir
  }

  static func simulatorKitPath(_ developerDir: String) -> String {
    "\(developerDir)/../SharedFrameworks/SimulatorKit.framework/SimulatorKit"
  }

  static let deviceSet: NSObject? = {
    guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil
    else { return nil }
    dlopen(simulatorKitPath(developerDir), RTLD_NOW)
    guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type,
      let context = contextClass.perform(
        NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), with: developerDir, with: nil
      )?.takeUnretainedValue() as? NSObject
    else { return nil }
    return context.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?
      .takeUnretainedValue() as? NSObject
  }()

  static func device(udid: String) -> NSObject? {
    guard let devices = deviceSet?.value(forKey: "devices") as? [NSObject] else { return nil }
    return devices.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
  }

  static func mainDisplay(udid: String) -> SimDisplay? {
    guard let device = device(udid: udid),
      let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject,
      let ports = io.perform(NSSelectorFromString("ioPorts"))?.takeUnretainedValue() as? [NSObject],
      let surfaceRenderable = objc_getProtocol("SimDisplayIOSurfaceRenderable"),
      let renderable = objc_getProtocol("SimDisplayRenderable"),
      let screen = objc_getProtocol("SimScreen")
    else { return nil }
    for port in ports {
      guard let descriptor = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject,
        descriptor.conforms(to: surfaceRenderable), descriptor.conforms(to: renderable), descriptor.conforms(to: screen)
      else { continue }
      let display = unsafeBitCast(descriptor, to: SimDisplay.self)
      if display.framebufferSurface != nil { return display }
    }
    return nil
  }
}
