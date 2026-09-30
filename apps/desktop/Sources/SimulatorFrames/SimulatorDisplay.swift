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
// display's native portrait orientation when the device rotates. screenType 0
// is a built-in display with a digitizer; TV out, CarPlay and resizable
// displays have other types.
@objc protocol SimScreenProperties {
  var uiOrientation: UInt32 { get }
  var screenID: UInt32 { get }
  var screenType: UInt { get }
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

  /// The screen IDs of the device's built-in displays that have a
  /// framebuffer, main display first. An iPhone Duo has two; it is empty until
  /// the device boots.
  public static func screenIDs(udid: String) -> [UInt32] {
    displays(udid: udid).compactMap { display in
      display.screenProperties.flatMap { $0.screenType == 0 ? $0.screenID : nil }
    }
  }

  static func displays(udid: String) -> [SimDisplay] {
    guard let device = device(udid: udid),
      let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject,
      let ports = io.perform(NSSelectorFromString("ioPorts"))?.takeUnretainedValue() as? [NSObject],
      let surfaceRenderable = objc_getProtocol("SimDisplayIOSurfaceRenderable"),
      let renderable = objc_getProtocol("SimDisplayRenderable"),
      let screen = objc_getProtocol("SimScreen")
    else { return [] }
    let displays = ports.compactMap { port -> SimDisplay? in
      guard let descriptor = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject,
        descriptor.conforms(to: surfaceRenderable), descriptor.conforms(to: renderable), descriptor.conforms(to: screen)
      else { return nil }
      let display = unsafeBitCast(descriptor, to: SimDisplay.self)
      return display.framebufferSurface == nil ? nil : display
    }
    return displays.sorted { ($0.screenProperties?.screenID ?? .max) < ($1.screenProperties?.screenID ?? .max) }
  }
}
