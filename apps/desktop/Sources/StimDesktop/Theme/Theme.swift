import AppKit
import CoreText
import StimKit
import SwiftUI

/// Stim's brand tokens from `website/src/css/custom.css`: the `[data-theme='dark']`
/// palette in dark appearance and the `:root` palette in light appearance.
enum Theme {
  static let purple = Color(hex: 0x5521FF)
  static let lavender = adaptive(dark: 0xAA90FF, light: 0x7045FF)
  static let primary = adaptive(dark: 0xB39CFF, light: 0x5521FF)

  static let background = adaptive(dark: 0x15121D, light: 0xFFFFFF)
  static let sidebar = adaptive(dark: 0x120F19, light: 0xF8F6FD)
  static let surface = adaptive(dark: 0x201B2B, light: 0xFCFBFF)
  static let raised = adaptive(dark: 0x2A2338, light: 0xF3EFFF)
  static let selected = adaptive(dark: 0x2E2445, light: 0xF3EFFF)
  static let border = adaptive(dark: 0x352A48, light: 0xECE7FA)
  static let screen = Color(hex: 0x0C0A11)

  static let text = adaptive(dark: 0xF3EFFF, light: 0x121212)
  static let secondary = adaptive(dark: 0xB8B0CC, light: 0x6B6B6B)
  static let tertiary = adaptive(dark: 0x8C84A3, light: 0x96929F)

  static let live = adaptive(dark: 0x4ADE80, light: 0x16A34A)
  static let warn = adaptive(dark: 0xF5B454, light: 0xB7791F)
  static let error = adaptive(dark: 0xFF6B6B, light: 0xDC2626)
  static let remote = adaptive(dark: 0x7AA7FF, light: 0x2F6BFF)

  private static func adaptive(dark: UInt32, light: UInt32) -> Color {
    Color(
      nsColor: NSColor(name: nil) { appearance in
        NSColor(hex: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light)
      })
  }

  /// Applies an appearance preference to every window.
  @MainActor static func apply(_ appearance: Appearance) {
    switch appearance {
    case .auto: NSApp.appearance = nil
    case .light: NSApp.appearance = NSAppearance(named: .aqua)
    case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
    }
  }

  static func body(_ size: CGFloat = 13, weight: Font.Weight = .regular) -> Font {
    .custom("InterVariable", size: size).weight(weight)
  }

  static func heading(_ size: CGFloat) -> Font {
    .custom("InterVariable", size: size).weight(.semibold)
  }

  static func mono(_ size: CGFloat = 11) -> Font {
    .custom("JetBrainsMono-Regular", size: size)
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255)
  }
}

extension NSColor {
  convenience init(hex: UInt32) {
    self.init(
      srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: 1)
  }
}

/// The website's fonts and brand artwork. A bundled app carries copies in
/// `Contents/Resources`; `swift run` reads them from the website sources.
enum BrandAssets {
  static func registerFonts() {
    for name in ["InterVariable.woff2", "JetBrainsMono-Regular.woff2"] {
      guard let url = url(name, websitePath: "src/css/fonts") else { continue }
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
  }

  static func logo(_ scheme: ColorScheme) -> NSImage? { scheme == .dark ? darkLogo : lightLogo }
  static func hero(_ scheme: ColorScheme) -> NSImage? { scheme == .dark ? darkHero : lightHero }

  private static let darkLogo = image("logo-dark.svg")
  private static let lightLogo = image("logo.svg")
  private static let darkHero = image("hero-dark.svg")
  private static let lightHero = image("hero.svg")

  private static func image(_ name: String) -> NSImage? {
    url(name, websitePath: "static/img/branding").flatMap(NSImage.init(contentsOf:))
  }

  private static func url(_ name: String, websitePath: String) -> URL? {
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent(name),
      FileManager.default.fileExists(atPath: bundled.path)
    {
      return bundled
    }
    let website = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../../../../website/\(websitePath)/\(name)")
      .standardizedFileURL
    return FileManager.default.fileExists(atPath: website.path) ? website : nil
  }
}
