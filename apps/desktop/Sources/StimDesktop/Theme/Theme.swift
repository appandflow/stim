import AppKit
import CoreText
import SwiftUI

/// Stim's brand tokens, matching `website/src/css/custom.css` in dark mode.
enum Theme {
  static let purple = Color(hex: 0x5521FF)
  static let lavender = Color(hex: 0xAA90FF)
  static let primary = Color(hex: 0xB39CFF)

  static let background = Color(hex: 0x15121D)
  static let sidebar = Color(hex: 0x120F19)
  static let surface = Color(hex: 0x201B2B)
  static let raised = Color(hex: 0x2A2338)
  static let selected = Color(hex: 0x2E2445)
  static let border = Color(hex: 0x352A48)
  static let screen = Color(hex: 0x0C0A11)

  static let text = Color(hex: 0xF3EFFF)
  static let secondary = Color(hex: 0xB8B0CC)
  static let tertiary = Color(hex: 0x8C84A3)

  static let live = Color(hex: 0x4ADE80)
  static let warn = Color(hex: 0xF5B454)
  static let error = Color(hex: 0xFF6B6B)
  static let remote = Color(hex: 0x7AA7FF)

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

/// The website's fonts and brand artwork. A bundled app carries copies in
/// `Contents/Resources`; `swift run` reads them from the website sources.
enum BrandAssets {
  static func registerFonts() {
    for name in ["InterVariable.woff2", "JetBrainsMono-Regular.woff2"] {
      guard let url = url(name, websitePath: "src/css/fonts") else { continue }
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
  }

  static let logo = image("logo-dark.svg")
  static let hero = image("hero-dark.svg")

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
