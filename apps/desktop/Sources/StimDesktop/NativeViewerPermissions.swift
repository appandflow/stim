import AppKit
import ApplicationServices
import Combine
import CoreGraphics
import Foundation

@MainActor
final class NativeViewerPermissions: ObservableObject {
  static let shared = NativeViewerPermissions()
  private static let offeredKey = "nativeViewerPermissionsOffered"

  @Published var showsSetup = false
  @Published private(set) var screenRecording = false
  @Published private(set) var accessibility = false
  @Published private(set) var revision = 0
  @Published private(set) var serverOwned: Bool?

  var screenPermissionTitle: String {
    if #available(macOS 15, *) { return "Screen & System Audio Recording" }
    return "Screen Recording"
  }

  var controlPermissionTitle: String {
    if #available(macOS 27, *) { return "Device Control and Data Access" }
    return "Accessibility"
  }

  var controlPermissionDetail: String {
    let use = "Lets Control interact with the captured app window and Open app bring it forward."
    if #available(macOS 27, *) { return "\(use) Named Accessibility on macOS 26 and earlier." }
    return use
  }

  var screenPermissionDetail: String {
    let use = "Shows the app's window in Desktop and on your paired phone."
    if #available(macOS 15, *) { return "\(use) Named Screen Recording on macOS 14." }
    return use
  }

  func viewerOpened(serverOwned: Bool? = nil) {
    if let serverOwned { self.serverOwned = serverOwned }
    guard !UserDefaults.standard.bool(forKey: Self.offeredKey) else { return }
    UserDefaults.standard.set(true, forKey: Self.offeredKey)
    openSetup()
  }

  func openSetup() {
    refresh()
    showsSetup = true
  }

  func refresh() {
    screenRecording = CGPreflightScreenCaptureAccess()
    accessibility = AXIsProcessTrusted() && CGPreflightPostEventAccess()
    revision += 1
  }

  func requestPermissions() {
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    if !AXIsProcessTrusted() {
      _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    } else if !CGPreflightPostEventAccess() {
      _ = CGRequestPostEventAccess()
    }
    refresh()
  }

  func openSettings(_ pane: String) {
    guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
    NSWorkspace.shared.open(url)
  }
}
