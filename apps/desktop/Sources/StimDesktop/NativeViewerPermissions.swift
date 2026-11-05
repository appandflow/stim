import AppKit
import ApplicationServices
import Combine
import CoreGraphics
import Foundation
import StimKit

@MainActor
final class NativeViewerPermissions: ObservableObject {
  static let shared = NativeViewerPermissions()
  private static let offeredKey = "nativeViewerPermissionsOffered"

  @Published var showsSetup = false
  @Published private(set) var screenRecording = false
  @Published private(set) var accessibility = false
  @Published private(set) var revision = 0
  @Published private(set) var serverOwned: Bool?

  init() {}

  #if DEBUG
    init(screenRecording: Bool, accessibility: Bool, serverOwned: Bool? = nil) {
      self.screenRecording = screenRecording
      self.accessibility = accessibility
      self.serverOwned = serverOwned
    }
  #endif

  var screenPermissionTitle: String {
    if #available(macOS 15, *) { return "Screen & System Audio Recording" }
    return "Screen Recording"
  }

  var controlPermissionTitle: String {
    if #available(macOS 27, *) { return "Device Control and Data Access" }
    return "Accessibility"
  }

  var controlPermissionAlias: String? {
    if #available(macOS 27, *) { return "Named Accessibility on macOS 26 and earlier." }
    return nil
  }

  var screenPermissionAlias: String? {
    if #available(macOS 15, *) { return "Named Screen Recording on macOS 14." }
    return nil
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

  func poll() {
    let screen = CGPreflightScreenCaptureAccess()
    let control = AXIsProcessTrusted() && CGPreflightPostEventAccess()
    guard screen != screenRecording || control != accessibility else { return }
    screenRecording = screen
    accessibility = control
    revision += 1
  }

  func requestScreenRecording() {
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    poll()
  }

  func requestControl() {
    if !AXIsProcessTrusted() {
      _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    } else if !CGPreflightPostEventAccess() {
      _ = CGRequestPostEventAccess()
    }
    poll()
  }

  func openSettings(_ pane: String) {
    guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
    NSWorkspace.shared.open(url)
  }
}
